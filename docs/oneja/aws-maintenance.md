# Maintaining the OneJA AWS Code Interpreter deployment

## Ownership and release boundary

Application source is maintained in `jaworldwideorg/librechat-code-interpreter`.
The canonical upstream is `LibreChat-AI/code-interpreter`; the legacy
`ClickHouse/code-interpreter` URL redirects to that repository. Helm charts,
production values, IAM/network/storage resources, deployment helpers and image
receipts are maintained in `jaworldwideorg/oneja-ai-infrastructure`.

The AWS migration branch started from fork commit
`cb56d4c6c31f77f96236a4e8758fdf449cbebc89`. The exact deployed application
commits, Docker configuration digests and immutable ECR references are recorded
per component in the infrastructure repository's
`config/codeapi-image-manifest.json`. Managed runner image version and its
separate source revision are recorded in `config/codeapi/managed-runner.json`.
Do not assume that every component was built from the same commit.

The fork's original Helm chart is unchanged. Changes to the infrastructure chart
must be reviewed there; an application upstream merge does not replace it.
Existing upstream CI/Images workflows remain manually disabled. The focused
`JA verified Code API release` workflow supplies the test dependencies and can
verify a branch with image publishing disabled. The existing upstream-sync/ACR
workflow does not update AWS's immutable deployed image references.

## OneJA runtime patch inventory

| Surface | Purpose | Compatibility requirement |
| --- | --- | --- |
| `api/src/entrypoint.sh` | Bound the cold-start document-tooling verifier independently: 30-second NsJail / 45-second outer deadline | Keep the full tooling check; do not increase user execution limits |
| `service/src/sandbox-backend/lambda-microvm.ts` | Probe authoritative VM state before warm reuse, recover checkpoints, preserve exact launch tokens and perform admission before execution | A terminated warm VM restores on its replacement request; inconclusive provider reads do not recycle live state |
| `service/src/{queue,file-server,tool-call-server,egress-ledger}.ts` | Verify Redis certificate chain and hostname | Managed TLS must remain verified; plain local Redis retains its existing non-TLS behavior |
| `service/src/runtime-session/admission.ts` | Shared coding/app capacity and one workspace/app per owner, durable uncertain-launch recovery | Never release capacity on timeout or termination acknowledgement alone; transient executions share the coding cap without an extra per-owner workspace restriction |
| `service/src/runtime-session/admission-dynamodb-aws.ts` | Strongly consistent reads and atomic policy/slot/owner/lease transactions | Workers cannot change the operator policy; normal bind cannot race a retiring launch; every coupled row is released atomically |
| `service/src/sandbox-backend/index.ts`, `config.ts` | Optional `CODEAPI_MICROVM_ADMISSION_TABLE` integration | Existing deployments without this setting retain the original backend path; production AWS values require it |
| `service/src/hosted-app/{factory,microvm-runtime,control-plane}.ts` | Pass trusted owner identity into shared app admission | No client-supplied owner substitution; no app egress connector or new application secrets |
| `service/src/runtime-session/lambda-client.ts` | Report the actual boot-retry token to the control plane | Preserve provider idempotency across restart and pending-intent recovery |
| `service/{package.json,bun.lock}` | Pin the DynamoDB SDK alongside the existing AWS SDK generation | Review lockfile/API changes together; use frozen dependency installation in verification/builds |

## Admission policy and recovery

The production table is `oneja-ai-codeapi-admission` in account `467816190573`,
Frankfurt. Its `policy#active` row contains an explicit revision and the limits.
The intended limits are ten coding VMs, four app VMs and fourteen total. Initial
capacity is two total VMs because the applied ARM allocation is 8 GiB and each
image has a 4 GiB baseline. A larger administrative quota does not itself change
the runtime policy or provision compute.

Reservation, owner and slot rows have no TTL. Redis failover, elapsed request
budgets and ambiguous provider responses cannot clear them. Unbound old intents
are atomically marked retiring before exact-token recovery; a normal bind that
wins remains authoritative. Recovery never executes user code. Release requires
an authoritative TERMINATED/not-found result, then an atomic delete of the four
coupled rows. Never delete a slot by guessing from its age.

Policy initialization/upgrades belong to infrastructure operator scripts, not
application workers. Verify the actual fleet and quota before initialization.
Change the policy revision for every update and require an atomic empty-fleet
check when changing slot limits; do not mutate the payload under the same
revision. Preserve prior image versions until all their leases have drained.

## Rehearsing an upstream merge

1. Start an isolated `codex/upstream-validation-YYYYMMDD` branch from the deployed
   worker source commit recorded in the infrastructure manifest (or from main
   after the migration PR has been merged). Preserve the currently deployed
   commits/images as rollback references.
2. Fetch `https://github.com/LibreChat-AI/code-interpreter.git` and merge its main
   branch into the validation branch. Review conflicts against the inventory
   above. Check owner/context propagation, SDK argument shapes, startup probes,
   TLS, deadline budgeting, pending-intent fencing and checkpoint schema changes.
3. Install `service/bun.lock` with `bun install --frozen-lockfile`; run the ESM
   typecheck, service suite and PTC regressions. Run the transaction tests against
   an isolated DynamoDB Local service, never the production table.
4. Run the full branch verification workflow with publishing disabled:

   ```sh
   gh workflow run ja-verified-release.yml --ref codex/upstream-validation-YYYYMMDD -f publish=false
   ```

   Check its completed result, including the DynamoDB tests. Do not treat a
   dispatched/running workflow or skipped transaction suite as a pass.
5. In the infrastructure repository, rebuild dependencies and run
   `bun test tests/codeapi-helm.test.ts`. Render both actual production profiles.
   Verify the admission table setting, TLS egress, component secrets, image
   references and absence of local privileged sandbox resources.
6. Build new images from a clean committed revision, publish immutable ECR tags,
   and verify remote configuration digests. A runner/app-host code or dependency
   change additionally requires a new managed image version and successful full
   startup verification. Review checkpoint/sidecar compatibility before mixing
   versions; drain incompatible session generations instead of silently reusing
   them.
7. Use synthetic owner-scoped canaries for missing-auth/profile protection,
   advertised languages, input/output and retained files, warm workspace reuse,
   VM replacement/checkpoint recovery, replay PTC, cancellation, owner isolation,
   shared capacity, and worker/cache/gateway failure recovery. Canary cleanup must
   select the exact trusted synthetic session, never every new VM in the fleet.
8. Update the infrastructure image/managed-version receipts and rollback packet,
   then promote the reviewed values. Production traffic changes are separate
   released steps. No mutable ACR/ECR `latest` tag controls an AWS release.

## Fast local checks

From the application repository:

```sh
cd service
bun install --frozen-lockfile
bunx tsc --noEmit -p tsconfig.esm.json
bun test src/runtime-session/admission.test.ts src/sandbox-backend/lambda-microvm.test.ts src/hosted-app/microvm-runtime.test.ts
```

The full suite needs `redis-server` and `jq`. Transaction tests additionally need
DynamoDB Local 3.3.2, pinned by image digest in the verification workflow. Set
`CODEAPI_ADMISSION_TEST_ENDPOINT=http://127.0.0.1:<test-port>` to run them; the
fixture rejects non-loopback endpoints and uses synthetic credentials/tables.

Infrastructure operator canaries and deployment/rollback instructions are in
`docs/codeapi-rollout.md` and `tools/` of `oneja-ai-infrastructure`. Keep these
instructions and the patch inventory current when removing, replacing or
upstreaming any overlay. Record evidence and unresolved limits in its journal.
