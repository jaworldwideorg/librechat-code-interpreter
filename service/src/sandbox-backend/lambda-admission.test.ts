import { beforeAll,beforeEach,afterAll,afterEach,describe,expect,test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import { DynamoDBClient,CreateTableCommand,DeleteTableCommand,DeleteItemCommand,PutItemCommand,ScanCommand } from '@aws-sdk/client-dynamodb';
import {randomUUID} from 'node:crypto';
import {DynamoMicrovmAdmissionStore} from '../runtime-session/admission-dynamodb-aws';
import {MicrovmAdmission,admissionLease} from '../runtime-session/admission';
import {FakeLambdaMicrovmClient} from '../runtime-session/lambda-client-fake';
import {LambdaMicrovmApiError} from '../runtime-session/lambda-client';
import {setRedisForTests as setThrottle,resetRedisForTests as resetThrottle} from '../runtime-session/throttle';
import {LambdaMicrovmSandboxBackend} from './lambda-microvm';
const endpoint=process.env.CODEAPI_ADMISSION_TEST_ENDPOINT;
if(endpoint && !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('Admission tests require loopback');
describe.skipIf(!endpoint)('Lambda backend with transactional admission',()=>{
  const db=new DynamoDBClient({endpoint,region:'eu-central-1',credentials:{accessKeyId:'localtest',secretAccessKey:'localtest'}});
  const table='backend-admission-'+randomUUID();
  const signal=()=>AbortSignal.timeout(5000);
  let store:DynamoMicrovmAdmissionStore,admission:MicrovmAdmission,fake:FakeLambdaMicrovmClient;
  let executions=0;
  let server:ReturnType<typeof Bun.serve>;
  const serve=()=>Bun.serve({port:0,fetch:request=>{
    if(new URL(request.url).pathname.endsWith('/execute')) {executions++;return Response.json({session_id:'test-session',files:[],run:{stdout:'proof',stderr:'',code:0,signal:null}});}
    return Response.json({status:'ok'});
  }});
  beforeAll(async()=>{server=serve();await db.send(new CreateTableCommand({TableName:table,KeySchema:[{AttributeName:'pk',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'}],BillingMode:'PAY_PER_REQUEST'}));});
  beforeEach(async()=>{
    const rows=await db.send(new ScanCommand({TableName:table}));for(const item of rows.Items??[]) await db.send(new DeleteItemCommand({TableName:table,Key:{pk:item.pk}}));
    await db.send(new PutItemCommand({TableName:table,Item:{pk:{S:'policy#active'},revision:{S:'test'},payload:{S:JSON.stringify({revision:'test',total:2,coding:10,app:4})}}}));
    store=new DynamoMicrovmAdmissionStore(table,{client:db});admission=new MicrovmAdmission(store);
    fake=new FakeLambdaMicrovmClient({endpointProvider:()=>`http://127.0.0.1:${server.port}`});executions=0;
    setThrottle(new RedisMock());
  });
  afterEach(()=>resetThrottle());
  afterAll(async()=>{server.stop();await db.send(new DeleteTableCommand({TableName:table}));db.destroy();});
  function backend(){return new LambdaMicrovmSandboxBackend({clientFactory:async()=>fake,admission,pollIntervalMs:1,config:{
    imageArn:'test-image',imageVersion:'2.0',port:8080,maxDurationSeconds:900,authTokenTtlSeconds:300,launchTimeoutMs:2000,healthTimeoutMs:500,launchTps:100,tokenTps:100,jobTimeoutMs:5000,idleSeconds:300,suspendedSeconds:900,lockWaitMs:500,checkpointsEnabled:false,checkpoint:{port:8080,authTokenTtlSeconds:300,maxBytes:1024,timeoutMs:500}
  }});}
  const request=()=>({body:{language:'python',version:'3.14.4',session_id:'test-session',files:[],egress_grant:'test-grant',execution_manifest:'test-manifest'},headers:{}});
  const context=()=>({executionId:randomUUID(),queuedJobId:randomUUID(),language:'python',isSynthetic:true,signal:signal(),runtimeSessionMode:'stateless' as const,tenantId:'trusted-tenant',canonicalUserId:'trusted-user'});
  function held(user:string){return admissionLease({tenant:'other',user,kind:'coding',lane:'workspace',request:{imageIdentifier:'test-image',clientToken:user,maximumDurationSeconds:900}});}
  test('full admission rejects before AWS launch or user execution',async()=>{
    await admission.reserve(held('one'),signal());await admission.reserve(held('two'),signal());
    await expect(backend().execute(request(),context())).rejects.toMatchObject({code:'MICROVM_LAUNCH_THROTTLED'});
    expect(fake.callsFor('runMicrovm').length).toBe(0);expect(executions).toBe(0);
  });
  test('successful one-shot execution releases every reservation row after provider termination',async()=>{
    const result=await backend().execute(request(),context());expect(result.run?.stdout).toBe('proof');expect(executions).toBe(1);
    expect(fake.callsFor('runMicrovm').length).toBe(1);expect(fake.callsFor('terminateMicrovm').length).toBe(1);
    expect(await store.leases(signal())).toEqual([]);
  });
  test('an uncertain RunMicrovm result retains its durable unbound reservation',async()=>{
    fake.failNext('runMicrovm',new LambdaMicrovmApiError('other','RunMicrovm','uncertain'));
    await expect(backend().execute(request(),context())).rejects.toMatchObject({code:'MICROVM_LAUNCH_FAILED'});
    const rows=await store.leases(signal());expect(rows.length).toBe(1);expect(rows[0].vmId).toBeUndefined();expect(executions).toBe(0);
  });
  test('lost binding acknowledgement terminates the VM before any user execution',async()=>{
    const bind=store.bind.bind(store);store.bind=async(...args)=>{await bind(...args);throw new Error('lost acknowledgement');};
    await expect(backend().execute(request(),context())).rejects.toMatchObject({code:'MICROVM_LAUNCH_FAILED'});
    expect(executions).toBe(0);expect(fake.callsFor('terminateMicrovm').length).toBe(1);expect(await store.leases(signal())).toEqual([]);
  });
});
