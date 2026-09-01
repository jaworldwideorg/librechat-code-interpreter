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
    # Preserve host mount binary before replacing /usr/sbin
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
    # Mount Debian sandbox userspace
    #

    mount_safe -o bind,ro "$ROOTFS/usr" /usr || {
        echo "FATAL: cannot bind /usr"
        exit 1
    }

    # Fedora may cache commands under /usr/sbin before the Debian /usr bind.
    # Clear those stale paths so subsequent commands resolve in the new tree.
    hash -r

    # Keep the live outer-container /etc (especially Docker resolv.conf),
    # but expose the Debian configuration consumed by binaries in ROOTFS/usr.
    for etc_path in alternatives fonts ImageMagick-7 libreoffice; do
        if [ -e "$ROOTFS/etc/$etc_path" ]; then
            mkdir -p "/etc/$etc_path"
            mount_safe -o bind,ro "$ROOTFS/etc/$etc_path" "/etc/$etc_path" || {
                echo "FATAL: cannot bind /etc/$etc_path"
                exit 1
            }
        fi
    done

    if [ -f "$ROOTFS/etc/ld.so.cache" ]; then
        mount_safe -o bind,ro "$ROOTFS/etc/ld.so.cache" /etc/ld.so.cache || {
            echo "FATAL: cannot bind /etc/ld.so.cache"
            exit 1
        }
    fi

    mkdir -p /var/cache/fontconfig
    mount_safe -o bind,ro "$ROOTFS/var/cache/fontconfig" /var/cache/fontconfig || {
        echo "FATAL: cannot bind /var/cache/fontconfig"
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
            echo "WARNING: could not bind /host-packages"
    fi

    multiarch_libdir=$(find /usr/lib -maxdepth 1 -type d -name "*-linux-gnu" -print -quit)

    if [ -n "$multiarch_libdir" ]; then
        export LD_LIBRARY_PATH="$multiarch_libdir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi


    export PATH="/root/.bun/bin:$PATH"


    exec /sandbox_api/entrypoint.sh
'
