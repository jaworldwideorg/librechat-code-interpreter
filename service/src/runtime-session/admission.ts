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
  retiring?: boolean;
  totalSlot?: number;
  kindSlot?: number;
}
export type AdmissionDecision = 'reserved' | 'existing' | 'full' | 'owner_busy' | 'policy_changed';
export interface MicrovmAdmissionStore {
  leases(signal: AbortSignal): Promise<AdmissionLease[]>;
  policy(signal: AbortSignal): Promise<AdmissionPolicy | undefined>;
  get(id: string, signal: AbortSignal): Promise<AdmissionLease | undefined>;
  reserve(lease: AdmissionLease, policy: AdmissionPolicy, signal: AbortSignal): Promise<AdmissionDecision>;
  beginRetirement(id: string, fingerprint: string, signal: AbortSignal): Promise<boolean>;
  bind(id: string, fingerprint: string, vmId: string, signal: AbortSignal, retiring?: boolean): Promise<void>;
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
      || !Number.isInteger(args.request.maximumDurationSeconds) || args.request.maximumDurationSeconds<1 || args.request.maximumDurationSeconds>28_800
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
        if(existing.retiring) throw new MicrovmAdmissionError('FULL','A previous launch is being recovered');
        return existing;
      }
      // A crashed boot retry can leave only the durable -r1 reservation.
      // Recover that exact owned request instead of taking a second owner slot.
      if (!lease.request.clientToken!.endsWith('-r1')) {
        const request = { ...lease.request, clientToken: lease.request.clientToken + '-r1' };
        const id = createHash('sha256').update(JSON.stringify([lease.kind, request.clientToken])).digest('hex');
        const fingerprint = createHash('sha256').update(JSON.stringify([lease.owner, lease.kind, lease.lane, request])).digest('hex');
        const retry = await this.store.get(id, signal);
        if (retry) {
          if (retry.fingerprint !== fingerprint) throw new MicrovmAdmissionError('CONFLICT', 'Boot retry ownership changed');
          if (retry.retiring) throw new MicrovmAdmissionError('FULL', 'A previous launch is being recovered');
          return retry;
        }
      }
      const policy=await this.store.policy(signal);
      if(!policy) throw new MicrovmAdmissionError('UNAVAILABLE','VM admission policy has not been initialized');
      const decision=await this.store.reserve(lease,validateAdmissionPolicy(policy),signal);
      if(decision==='full' || decision==='owner_busy') {
        const raced=await this.store.get(lease.id,signal);
        if(raced) {
          if(raced.fingerprint!==lease.fingerprint) throw new MicrovmAdmissionError('CONFLICT','Launch reservation identity changed');
          if(raced.retiring) throw new MicrovmAdmissionError('FULL','A previous launch is being recovered');
          return raced;
        }
      }
      if(decision==='full') throw new MicrovmAdmissionError('FULL','VM fleet is at its approved capacity');
      if(decision==='owner_busy') throw new MicrovmAdmissionError('OWNER_BUSY','Owner already has this workspace or app');
      if(decision==='policy_changed') continue;
      const accepted=await this.store.get(lease.id,signal);
      if(!accepted || accepted.fingerprint!==lease.fingerprint) throw new MicrovmAdmissionError('CONFLICT','VM admission acknowledgement cannot be verified');
      if(accepted.retiring) throw new MicrovmAdmissionError('FULL','A previous launch is being recovered');
      return accepted;
    }
    throw new MicrovmAdmissionError('UNAVAILABLE','VM admission policy is changing');
  }
  async reserveWhenAvailable(lease: AdmissionLease, client: LambdaMicrovmClient, options: {
    signal: AbortSignal; minimumAgeMs: number; beforeRun: () => Promise<void>;
  }): Promise<AdmissionLease> {
    for (;;) {
      options.signal.throwIfAborted();
      try { return await this.reserve(lease, options.signal); }
      catch (error) {
        if (!(error instanceof MicrovmAdmissionError) || error.code !== 'FULL') throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => { options.signal.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, 1_000);
        const abort = () => { clearTimeout(timer); options.signal.removeEventListener('abort', abort); reject(options.signal.reason); };
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
      });
      await this.reconcile(client, options);
    }
  }
  async reconcile(client: LambdaMicrovmClient, options: {
    signal: AbortSignal; minimumAgeMs: number; beforeRun: () => Promise<void>;
  }): Promise<{ freed: number; held: number; errors: number }> {
    const out = { freed: 0, held: 0, errors: 0 };
    const leases = await this.store.leases(options.signal);
    for (const lease of leases) {
      options.signal.throwIfAborted();
      try {
        const freed = lease.vmId && !lease.retiring
          ? await this.releaseIfTerminated(lease, client, options.signal)
          : await this.retireUnbound(lease, client, options);
        if (freed) out.freed++; else out.held++;
      } catch {
        out.held++; out.errors++;
      }
    }
    return out;
  }
  async releaseVmIfTerminated(vmId: string, client: LambdaMicrovmClient, signal: AbortSignal): Promise<boolean> {
    const leases = (await this.store.leases(signal)).filter(lease => lease.vmId === vmId);
    for (const lease of leases) if (!await this.releaseIfTerminated(lease, client, signal)) return false;
    return true;
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
    if(current.vmId) {
      if(current.retiring) {
        try { await client.terminateMicrovm(current.vmId,options.signal); }
        catch(error) { if(!(error instanceof LambdaMicrovmApiError) || error.kind!=='not_found') throw error; }
      }
      return this.releaseIfTerminated(current,client,options.signal);
    }
    if(!Number.isFinite(options.minimumAgeMs) || options.minimumAgeMs<120_000) throw new MicrovmAdmissionError('CONFLICT','Pending launch retirement requires a bounded grace period');
    if(Date.now()-current.createdAt<options.minimumAgeMs) return false;
    // Atomically fence normal bind/execute before retiring an unbound intent.
    // A concurrent normal bind that wins remains authoritative and is not killed.
    if(!await this.store.beginRetirement(current.id,current.fingerprint,options.signal)) return false;
    await options.beforeRun();
    const vm=await client.runMicrovm(current.request,options.signal,options.signal);
    await this.store.bind(current.id,current.fingerprint,vm.microvmId,options.signal,true);
    await client.terminateMicrovm(vm.microvmId,options.signal);
    return this.releaseIfTerminated(current,client,options.signal);
  }
}
