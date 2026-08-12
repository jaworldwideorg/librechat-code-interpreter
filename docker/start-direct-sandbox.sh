#!/bin/bash

echo "Starting Sandbox (direct NsJail, no microVM) on port 2000..."

ROOTFS="${SANDBOX_ROOTFS:-/sandbox-rootfs}"

mkdir -p /sandbox_api /pkgs

if mount -o remount,rw /sys/fs/cgroup 2>/dev/null; then
    echo "[sandbox] Remounted cgroupfs as rw"
else
    echo "[sandbox] WARNING: could not remount cgroupfs rw - NsJail cgroup isolation may fail"
fi

mkdir -p /sys/fs/cgroup/init
echo "[sandbox] Draining root cgroup ($(wc -w < /sys/fs/cgroup/cgroup.procs 2>/dev/null || echo '?') procs) into init/..."

_root_procs=$(cat /sys/fs/cgroup/cgroup.procs 2>/dev/null || true)

for _pid in $_root_procs; do
    echo "$_pid" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
done

_remaining=$(wc -w < /sys/fs/cgroup/cgroup.procs 2>/dev/null || echo "?")
echo "[sandbox] Root cgroup procs after drain: $_remaining"

if echo "+memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null; then
    echo "[sandbox] Enabled +memory +pids on root cgroup.subtree_control"
else
    echo "[sandbox] WARNING: could not enable controllers on root ($_remaining procs remain)"
fi

PROC_SUBMOUNTS=$(awk '$5 ~ /^\/proc\/./ {print $5}' /proc/self/mountinfo 2>/dev/null | sort -r)

if [ -n "$PROC_SUBMOUNTS" ]; then
    echo "[sandbox] Removing $(echo "$PROC_SUBMOUNTS" | wc -l) /proc submounts for fresh procfs support..."

    for mnt in $PROC_SUBMOUNTS; do
        umount "$mnt" 2>/dev/null || true
    done

    REMAINING=$(awk '$5 ~ /^\/proc\/./ {print $5}' /proc/self/mountinfo 2>/dev/null | wc -l)

    if [ "$REMAINING" -eq 0 ]; then
        echo "[sandbox] All /proc submounts removed"
    else
        echo "[sandbox] WARNING: $REMAINING /proc submounts remain"
    fi
else
    echo "[sandbox] No /proc submounts to remove"
fi

export SANDBOX_ROOTFS="$ROOTFS"

exec unshare --mount bash -c '
    ROOTFS="${SANDBOX_ROOTFS:-/sandbox-rootfs}"

    #
    # Resolve the Debian loader and multiarch library directory BEFORE
    # replacing any of the Fedora userspace directories.
    #

    DEBIAN_LOADER="$(readlink -f "$ROOTFS/lib64/ld-linux-x86-64.so.2")"

    if [ ! -f "$DEBIAN_LOADER" ]; then
        echo "FATAL: Debian dynamic loader not found: $DEBIAN_LOADER"
        exit 1
    fi

    DEBIAN_MULTIARCH=""

    for d in "$ROOTFS"/usr/lib/*-linux-gnu; do
        if [ -d "$d" ]; then
            DEBIAN_MULTIARCH="/usr/lib/${d##*/}"
            break
        fi
    done

    if [ -z "$DEBIAN_MULTIARCH" ]; then
        echo "FATAL: Debian multiarch library directory not found"
        exit 1
    fi

    echo "[sandbox] Debian loader: $DEBIAN_LOADER"
    echo "[sandbox] Debian multiarch libs: $DEBIAN_MULTIARCH"


    #
    # Keep a self-contained copy of Fedora mount + its runtime.
    #
    # We need this because we are about to replace /usr/sbin, /usr/lib,
    # and /usr/bin with the Debian sandbox rootfs.
    #

    mkdir -p /tmp/mount-bin

    cp -L --parents /usr/sbin/mount /tmp/mount-bin/
    cp -L --parents /lib64/libmount.so.1 /tmp/mount-bin/
    cp -L --parents /lib64/libselinux.so.1 /tmp/mount-bin/
    cp -L --parents /lib64/libblkid.so.1 /tmp/mount-bin/
    cp -L --parents /lib64/libpcre2-8.so.0 /tmp/mount-bin/
    cp -L --parents /lib64/libc.so.6 /tmp/mount-bin/
    cp -L --parents /lib64/ld-linux-x86-64.so.2 /tmp/mount-bin/

    chmod +x /tmp/mount-bin/usr/sbin/mount

    mount_safe() {
        /tmp/mount-bin/lib64/ld-linux-x86-64.so.2 \
            --library-path /tmp/mount-bin/lib64 \
            /tmp/mount-bin/usr/sbin/mount "$@"
    }


    #
    # Overlay the Debian sandbox userspace.
    #

    mount_safe -o bind,ro "$ROOTFS/usr/sbin" /usr/sbin || {
        echo "FATAL: cannot bind /usr/sbin"
        exit 1
    }

    mount_safe -o bind,ro "$ROOTFS/usr/lib" /usr/lib || {
        echo "FATAL: cannot bind /usr/lib"
        exit 1
    }

    if [ -d "$ROOTFS/usr/lib64" ] && ! [ -L "$ROOTFS/usr/lib64" ]; then
        mount_safe -o bind,ro "$ROOTFS/usr/lib64" /usr/lib64 2>/dev/null || \
            echo "[sandbox] WARNING: could not bind /usr/lib64"
    fi


    #
    # CRITICAL:
    #
    # Fedora owns /lib64/ld-linux-x86-64.so.2 in the outer worker image.
    # Debian NsJail must run using the Debian loader instead.
    #
    # Bind the Debian loader over the loader path used by subsequently
    # executed Debian ELF binaries.
    #

    mount_safe --bind \
        "$DEBIAN_LOADER" \
        /lib64/ld-linux-x86-64.so.2 || {
            echo "FATAL: cannot bind Debian dynamic loader"
            exit 1
        }

    echo "[sandbox] Debian dynamic loader installed"


    #
    # Continue overlaying the sandbox rootfs.
    #

    mount_safe -o bind,ro "$ROOTFS/usr/local" /usr/local || {
        echo "FATAL: cannot bind /usr/local"
        exit 1
    }

    mount_safe -o bind,ro "$ROOTFS/sandbox_api" /sandbox_api || {
        echo "FATAL: cannot bind /sandbox_api"
        exit 1
    }

    mount_safe -o bind,ro "$ROOTFS/pkgs" /pkgs || {
        echo "FATAL: cannot bind /pkgs"
        exit 1
    }

    if [ -d /host-packages ]; then
        mount_safe --bind /host-packages /pkgs 2>/dev/null || \
            echo "WARNING: could not bind /host-packages - sandbox will run without packages"
    fi


    #
    # /usr/bin goes last because replacing it changes bash/coreutils/etc.
    #

    mount_safe -o bind,ro "$ROOTFS/usr/bin" /usr/bin || {
        echo "FATAL: cannot bind /usr/bin"
        exit 1
    }


    #
    # Give Debian binaries their matching runtime libraries.
    #

    export LD_LIBRARY_PATH="$DEBIAN_MULTIARCH:/usr/lib"

    export PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"

    echo "[sandbox] LD_LIBRARY_PATH=$LD_LIBRARY_PATH"


    #
    # Quick preflight. This should now use:
    #
    #   Debian /usr/sbin/nsjail
    #   Debian ld-linux
    #   Debian libraries
    #

    if /usr/sbin/nsjail --help >/dev/null 2>&1; then
        echo "[sandbox] NsJail runtime preflight passed"
    else
        status=$?
        echo "FATAL: NsJail runtime preflight failed (exit $status)"
        exit "$status"
    fi


    #
    # Launch the sandbox API. Its own smoke test will perform the
    # full NsJail/cgroup/user-namespace validation.
    #

    exec /sandbox_api/entrypoint.sh
'