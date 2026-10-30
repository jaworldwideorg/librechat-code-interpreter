import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helm = process.env.HELM_BIN ?? 'helm';
const lambdaOptions = [
  'workerSandbox.backend=lambda-microvm', 'workerSandbox.runtimeSessionMode=affinity',
  'executionProfile=stateful', 'generatedSecrets.enabled=false',
  'existingSecrets.api=external-api', 'existingSecrets.worker=external-worker',
  'existingSecrets.fileServer=external-files', 'existingSecrets.toolCallServer=external-tools',
  'existingSecrets.egressGateway=external-gateway', 'redis.enabled=false',
  'redis.external.host=redis.example.internal', 'redis.external.port=6379',
  'minio.enabled=false', 'minio.useSimple=false', 'fileServer.s3.enabled=true',
  'fileServer.s3.useIrsa=true', 'fileServer.s3.bucket=test-files',
  'networkPolicy.controlPlaneTlsCIDRs[0]=10.64.16.0/20',
  'networkPolicy.egressGateway.externalIngressCIDRs[0]=10.64.96.0/24',
  'metrics.enabled=true', 'workerSandbox.sandboxRunner.autoscaling.enabled=true',
];

function render(options: string[]) {
  return spawnSync(helm, ['template', 'codeapi', 'helm/codeapi', '-f', 'helm/codeapi/values-local.yaml',
    ...options.flatMap((option) => ['--set', option])], { cwd: root, encoding: 'utf8' });
}

function documents(text: string): any[] {
  return text.split(/^---\s*$/m).map((doc) => Bun.YAML.parse(doc)).filter(Boolean);
}

describe('Lambda Helm deployment', () => {
  test('retains the existing local HTTP sandbox deployment', () => {
    const result = render([]);
    expect(result.status).toBe(0);
    const docs = documents(result.stdout);
    expect(docs.some((d) => d.kind === 'Deployment' && d.metadata.name.endsWith('-sandbox-runner'))).toBe(true);
    expect(docs.some((d) => d.kind === 'Job' && d.metadata.name.endsWith('-package-init'))).toBe(true);
  });

  test('omits every local sandbox resource and dependency in Lambda mode', () => {
    const result = render(lambdaOptions);
    expect(result.status).toBe(0);
    const docs = documents(result.stdout);
    expect(docs.some((d) => d.metadata?.name?.endsWith('-sandbox-runner'))).toBe(false);
    expect(docs.some((d) => d.kind === 'PersistentVolumeClaim' || d.kind === 'Job')).toBe(false);
    const worker = docs.find((d) => d.kind === 'Deployment' && d.metadata.name.endsWith('-service-worker'));
    expect(worker.spec.template.spec.initContainers.map((c: any) => c.name)).toEqual(['wait-for-redis']);
    const env = worker.spec.template.spec.containers[0].env;
    expect(env.some((e: any) => e.name === 'SANDBOX_ENDPOINT')).toBe(false);
    expect(env.find((e: any) => e.name === 'CODEAPI_SANDBOX_BACKEND').value).toBe('lambda-microvm');
    expect(env.find((e: any) => e.name === 'CODEAPI_RUNTIME_SESSION_MODE').value).toBe('affinity');
    expect(env.find((e: any) => e.name === 'CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY').valueFrom.secretKeyRef.name).toBe('external-worker');
  });

  test('keeps component secrets separate and renders no generated secrets', () => {
    const result = render(lambdaOptions);
    expect(result.status).toBe(0);
    const docs = documents(result.stdout);
    expect(docs.some((d) => d.kind === 'Secret')).toBe(false);
    const api = docs.find((d) => d.kind === 'Deployment' && d.metadata.name.endsWith('-api'));
    const gateway = docs.find((d) => d.kind === 'Deployment' && d.metadata.name.endsWith('-egress-gateway'));
    for (const [deployment, expectedSecret] of [[api, 'external-api'], [gateway, 'external-gateway']]) {
      const env = deployment.spec.template.spec.containers[0].env;
      expect(env.filter((e: any) => e.valueFrom?.secretKeyRef).every((e: any) => e.valueFrom.secretKeyRef.name === expectedSecret)).toBe(true);
      expect(env.some((e: any) => e.name === 'CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY')).toBe(false);
    }
    expect(api.spec.template.spec.containers[0].env.find((e: any) => e.name === 'CODEAPI_RUNTIME_SESSION_MODE').value).toBe('affinity');
  });

  test('requires scoped TLS egress when network policies are enabled', () => {
    const result = render(lambdaOptions.filter((o) => !o.startsWith('networkPolicy.controlPlaneTlsCIDRs')));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('controlPlaneTlsCIDRs');
  });

  test('rejects a stateful Lambda deployment using the default queue profile', () => {
    const result = render(lambdaOptions.map((o) => o === 'executionProfile=stateful' ? 'executionProfile=default' : o));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('executionProfile=stateful');
  });
});
