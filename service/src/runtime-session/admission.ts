import { createHash } from 'node:crypto';
import { LambdaMicrovmApiError, type LambdaMicrovmClient, type RunMicrovmArgs } from './lambda-client';

export type AdmissionKind = 'coding' | 'app';
export type AdmissionLane = 'workspace' | 'execution' | 'app';
export interface AdmissionPolicy {
  revision: string;
  total: number;
  coding: number;
  app: number;
}
export interface AdmissionLease {
  id: string;
  owner: string;
  kind: AdmissionKind;
  lane: AdmissionLane;
  fingerprint: string;
  createdAt: number;
  request: RunMicrovmArgs;
  vmId?: string;
  totalSlot?: number;
  kindSlot?: number;
}
export type AdmissionDecision = 'reserved' | 'existing' | 'full' | 'owner_busy' | 'policy_changed';
export interface MicrovmAdmissionStore {
  policy(signal: AbortSignal): Promise<AdmissionPolicy | undefined>;
  get(id: string, signal: AbortSignal): Promise<AdmissionLease | undefined>;
  reserve(lease: AdmissionLease, policy: AdmissionPolicy, signal: AbortSignal): Promise<AdmissionDecision>;
  bind(id: string, fingerprint: string, vmId: string, signal: AbortSignal): Promise<void>;
  release(lease: AdmissionLease, expectedVmId: string, signal: AbortSignal): Promise<void>;
}
export class MicrovmAdmissionError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'FULL' | 'OWNER_BUSY' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'MicrovmAdmissionError';
  }
}
export function validateAdmissionPolicy(policy: AdmissionPolicy): AdmissionPolicy {
  if (!policy.revision || !Number.isInteger(policy.total) || policy.total < 1 || policy.total > 14
      || !Number.isInteger(policy.coding) || policy.coding < 1 || policy.coding > 10
      || !Number.isInteger(policy.app) || policy.app < 0 || policy.app > 4) {
    throw new MicrovmAdmissionError('UNAVAILABLE', 'VM admission policy is invalid');
  }
  return policy;
}
export function admissionLease(args: {
  tenant: string; user: string; kind: AdmissionKind; lane: AdmissionLane; request: RunMicrovmArgs;
}): AdmissionLease {
  if (!args.tenant || !args.user || !args.request.clientToken || args.request.runHookPayload != null
      || (args.kind === 'app') !== (args.lane === 'app')) {
    throw new MicrovmAdmissionError('CONFLICT', 'VM admission requires trusted owner and launch identity');
  }
  const owner = createHash('sha256').update(JSON.stringify([args.tenant,args.user])).digest('hex');
  const id = createHash('sha256').update(JSON.stringify([args.kind,args.request.clientToken])).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify([owner,args.kind,args.lane,args.request])).digest('hex');
  return {id,owner,kind:args.kind,lane:args.lane,fingerprint,request:args.request,createdAt:Date.now()};
}

/** Durable admission has no wall-clock expiration. AWS termination acknowledgement,
 * Redis loss, a stale worker or an elapsed request deadline cannot free a slot.
 * Capacity is released only after authoritative provider terminal/not-found proof. */
export class MicrovmAdmission {
  constructor(readonly store: MicrovmAdmissionStore) {}
  async reserve(lease: AdmissionLease, signal: AbortSignal): Promise<AdmissionLease> {
    for(let attempt=0;attempt<4;attempt++) {
      signal.throwIfAborted();
      const existing=await this.store.get(lease.id,signal);
      if(existing) {
        if(existing.fingerprint!==lease.fingerprint) throw new MicrovmAdmissionError('CONFLICT','Launch reservation identity changed');
        return existing;
      }
      const policy=await this.store.policy(signal);
      if(!policy) throw new MicrovmAdmissionError('UNAVAILABLE','VM admission policy has not been initialized');
      const decision=await this.store.reserve(lease,validateAdmissionPolicy(policy),signal);
      if(decision==='full') throw new MicrovmAdmissionError('FULL','VM fleet is at its approved capacity');
      if(decision==='owner_busy') throw new MicrovmAdmissionError('OWNER_BUSY','Owner already has this workspace, app or execution');
      if(decision==='policy_changed') continue;
      const accepted=await this.store.get(lease.id,signal);
      if(!accepted || accepted.fingerprint!==lease.fingerprint) throw new MicrovmAdmissionError('CONFLICT','VM admission acknowledgement cannot be verified');
      return accepted;
    }
    throw new MicrovmAdmissionError('UNAVAILABLE','VM admission policy is changing');
  }
  async bind(lease: AdmissionLease, vmId: string, signal: AbortSignal): Promise<void> {
    if(!vmId) throw new MicrovmAdmissionError('CONFLICT','Missing provider VM identity');
    await this.store.bind(lease.id,lease.fingerprint,vmId,signal);
  }
  async releaseIfTerminated(lease: AdmissionLease, client: LambdaMicrovmClient, signal: AbortSignal): Promise<boolean> {
    const current=await this.store.get(lease.id,signal);
    if(!current) return true;
    if(current.fingerprint!==lease.fingerprint) throw new MicrovmAdmissionError('CONFLICT','VM admission identity changed');
    if(!current.vmId) return false;
    try {
      const vm=await client.getMicrovm(current.vmId,signal);
      if(vm.state!=='TERMINATED') return false;
    } catch(error) {
      if(!(error instanceof LambdaMicrovmApiError) || error.kind!=='not_found') throw error;
    }
    await this.store.release(current,current.vmId,signal);
    return true;
  }
  /** A crashed or timed-out launch retains capacity. Recover only its exact
   * persisted provider token/arguments, then terminate without executing code.
   * The caller supplies launch throttling and an independent bounded signal. */
  async retireUnbound(lease: AdmissionLease, client: LambdaMicrovmClient, options: {
    signal: AbortSignal; minimumAgeMs: number; beforeRun: () => Promise<void>;
  }): Promise<boolean> {
    const current=await this.store.get(lease.id,options.signal);
    if(!current) return true;
    if(current.fingerprint!==lease.fingerprint) throw new MicrovmAdmissionError('CONFLICT','VM admission identity changed');
    if(current.vmId) return this.releaseIfTerminated(current,client,options.signal);
    if(!Number.isFinite(options.minimumAgeMs) || options.minimumAgeMs<120_000) throw new MicrovmAdmissionError('CONFLICT','Pending launch retirement requires a bounded grace period');
    if(Date.now()-current.createdAt<options.minimumAgeMs) return false;
    await options.beforeRun();
    const vm=await client.runMicrovm(current.request,options.signal,options.signal);
    await this.bind(current,vm.microvmId,options.signal);
    await client.terminateMicrovm(vm.microvmId,options.signal);
    return this.releaseIfTerminated(current,client,options.signal);
  }
}
