import { beforeAll, beforeEach, afterAll, describe, expect, test } from 'bun:test';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand, PutItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { DynamoMicrovmAdmissionStore } from './admission-dynamodb-aws';
import { admissionLease, MicrovmAdmission } from './admission';

const endpoint=process.env.CODEAPI_ADMISSION_TEST_ENDPOINT;
// These tests use an isolated local service and synthetic credentials only.
// Production table tests are exercised separately through the worker IAM role.
if(endpoint && !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('Admission tests require a loopback endpoint');
describe.skipIf(!endpoint)('DynamoDB transactional admission',()=>{
  const client=new DynamoDBClient({endpoint,region:'eu-central-1',credentials:{accessKeyId:'localtest',secretAccessKey:'localtest'},maxAttempts:3});
  const table='admission-test-'+randomUUID();
  const signal=()=>AbortSignal.timeout(30000);
  let store:DynamoMicrovmAdmissionStore;
  let admission:MicrovmAdmission;
  beforeAll(async()=>{
    await client.send(new CreateTableCommand({TableName:table,KeySchema:[{AttributeName:'pk',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'}],BillingMode:'PAY_PER_REQUEST'}));
  });
  afterAll(async()=>{await client.send(new DeleteTableCommand({TableName:table}));client.destroy();});
  beforeEach(async()=>{
    const rows=await client.send(new ScanCommand({TableName:table}));
    const {DeleteItemCommand}=await import('@aws-sdk/client-dynamodb');
    for(const item of rows.Items??[]) await client.send(new DeleteItemCommand({TableName:table,Key:{pk:item.pk}}));
    await client.send(new PutItemCommand({TableName:table,Item:{pk:{S:'policy#active'},revision:{S:'v1'},payload:{S:JSON.stringify({revision:'v1',total:2,coding:10,app:4})}}}));
    store=new DynamoMicrovmAdmissionStore(table,{client});admission=new MicrovmAdmission(store);
  });
  function lease(user:string,token:string=user,kind:'coding'|'app'='coding') {
    return admissionLease({tenant:'test',user,kind,lane:kind==='coding'?'workspace':'app',request:{imageIdentifier:'test-image',clientToken:token,maximumDurationSeconds:900}});
  }
  test('parallel replicas never admit more than the shared two-VM cap',async()=>{
    const decisions=await Promise.allSettled(Array.from({length:20},(_,i)=>new MicrovmAdmission(new DynamoMicrovmAdmissionStore(table,{client})).reserve(lease('user-'+i),signal())));
    expect(decisions.filter(r=>r.status==='fulfilled').length).toBe(2);
    const rows=await client.send(new ScanCommand({TableName:table,ConsistentRead:true}));
    expect(rows.Items?.filter(e=>e.pk.S?.startsWith('lease#')).length).toBe(2);
    expect(rows.Items?.filter(e=>e.pk.S?.startsWith('slot#total#')).length).toBe(2);
  });
  test('concurrent same-token retries use one reservation despite different creation times',async()=>{
    const source=lease('owner','same-token');
    const values=await Promise.all(Array.from({length:8},(_,i)=>admission.reserve({...source,createdAt:source.createdAt+i},signal())));
    expect(new Set(values.map(e=>e.id)).size).toBe(1);
    const rows=await client.send(new ScanCommand({TableName:table}));
    expect(rows.Items?.filter(e=>e.pk.S?.startsWith('lease#')).length).toBe(1);
  });
  test('retirement and a normal bind cannot both win',async()=>{
    const e=await admission.reserve(lease('owner'),signal());
    const outcomes=await Promise.allSettled([store.beginRetirement(e.id,e.fingerprint,signal()),store.bind(e.id,e.fingerprint,'vm-active',signal())]);
    const current=await store.get(e.id,signal());
    if(current?.retiring) {
      expect(outcomes[1].status).toBe('rejected');
      await expect(store.bind(e.id,e.fingerprint,'vm-active',signal())).rejects.toMatchObject({code:'CONFLICT'});
    } else {
      expect(current?.vmId).toBe('vm-active');expect((outcomes[0] as PromiseFulfilledResult<boolean>).value).toBe(false);
    }
  });
  test('an accepted boot retry is recovered without another owner slot',async()=>{
    const retry=lease('owner','boot-r1');await admission.reserve(retry,signal());await admission.bind(retry,'vm-retry',signal());
    const recovered=await admission.reserve(lease('owner','boot'),signal());
    expect(recovered.id).toBe(retry.id);expect(recovered.request.clientToken).toBe('boot-r1');
    expect((await store.leases(signal())).length).toBe(1);
  });
  test('owner contention cannot create a second workspace',async()=>{
    const decisions=await Promise.allSettled([admission.reserve(lease('one','first'),signal()),admission.reserve(lease('one','second'),signal())]);
    expect(decisions.filter(r=>r.status==='fulfilled').length).toBe(1);
    expect(decisions.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason.code)).toEqual(['OWNER_BUSY']);
  });
  test('coding and app slots share the total cap',async()=>{
    await admission.reserve(lease('one'),signal());await admission.reserve(lease('two','app','app'),signal());
    await expect(admission.reserve(lease('three'),signal())).rejects.toMatchObject({code:'FULL'});
  });
  test('VM binding rejects a different resource and terminal release clears all coupled rows',async()=>{
    const e=await admission.reserve(lease('one'),signal());
    await admission.bind(e,'vm-one',signal());await admission.bind(e,'vm-one',signal());
    await expect(admission.bind(e,'vm-other',signal())).rejects.toMatchObject({code:'CONFLICT'});
    await store.release({...e,vmId:'vm-one'},'vm-one',signal());
    const rows=await client.send(new ScanCommand({TableName:table,ConsistentRead:true}));
    expect(rows.Items?.length).toBe(1);expect(rows.Items?.[0].pk.S).toBe('policy#active');
  });
  test('an old release cannot clear a new owner reservation after slot reuse',async()=>{
    const first=await admission.reserve(lease('one'),signal());await admission.bind(first,'vm-one',signal());
    await store.release({...first,vmId:'vm-one'},'vm-one',signal());
    const second=await admission.reserve(lease('two'),signal());await admission.bind(second,'vm-two',signal());
    await store.release({...first,vmId:'vm-one'},'vm-one',signal());
    expect((await store.get(second.id,signal()))?.vmId).toBe('vm-two');
  });
});
