#!/usr/bin/env bash
set -euo pipefail

# Run against the final combined image, not its sandbox-rootfs build stage.
# Requires a native Linux Docker CPU and privileged mount-namespace support.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:?usage: bash tests/direct_pipe_runtime.sh WORKER_SANDBOX_IMAGE}"

run_guest() {
    docker run --rm --init --privileged \
        --mount "type=bind,source=$ROOT,target=/work,readonly" \
        --mount "type=bind,source=$ROOT/tests,target=/tests,readonly" \
        --entrypoint /usr/bin/unshare "$IMAGE" \
        --mount /sandbox-rootfs-setup /sandbox-rootfs "$@"
}

# No addon env injection: this must work using the final image's own defaults.
run_guest /usr/local/bin/sandbox-supervisor-policy \
    /usr/local/bin/bun test /work/api/src/pipe-process.test.ts
run_guest /usr/local/bin/sandbox-supervisor-policy \
    /usr/local/bin/node /tests/pipe_runtime_image.cjs

# Exercise the real entrypoint, stopping after its early preflight. Replace
# mount with a sentinel so a successful preflight cannot start the API or
# change mounts; an invalid override must fail before reaching the sentinel.
run_guest /bin/bash -c '
    mount() { echo "PASS: entrypoint pipe preflight"; exit 73; }
    export -f mount
    check() {
        local expected="$1" result=0 output
        output=$("${@:2}" /bin/bash /sandbox_api/entrypoint.sh 2>&1) || result=$?
        printf "%s\n" "$output"
        test "$result" = "$expected"
        if [ "$expected" = 1 ]; then
            [[ "$output" == *"FATAL: sandbox pipe addon could not be loaded:"* ]]
            [[ "$output" != *"PASS: entrypoint pipe preflight"* ]]
        else
            [[ "$output" == *"PASS: entrypoint pipe preflight"* ]]
        fi
    }
    set -e
    check 73 env -u SANDBOX_PIPE_ADDON
    check 73 env SANDBOX_PIPE_ADDON=/usr/local/lib/anonymous-pipes.node
    check 1 env SANDBOX_PIPE_ADDON=/missing-pipe-addon.node
'

echo 'PASS: final direct runner addon, pipe transport and entrypoint defaults'
