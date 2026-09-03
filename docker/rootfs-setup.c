#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

static int bind_mount(const char *source, const char *target, int read_only) {
  if (mount(source, target, NULL, MS_BIND | MS_REC, NULL) != 0) {
    fprintf(stderr, "bind %s -> %s failed: %s\n", source, target, strerror(errno));
    return -1;
  }

  if (read_only &&
      mount(NULL, target, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL) != 0) {
    fprintf(stderr, "read-only remount of %s failed: %s\n", target, strerror(errno));
    return -1;
  }

  return 0;
}

static int rootfs_source_path(const char *rootfs, const char *path,
                              char source[PATH_MAX]) {
  int written = snprintf(source, PATH_MAX, "%s%s", rootfs, path);
  if (written < 0 || written >= PATH_MAX) {
    fprintf(stderr, "rootfs path is too long: %s%s\n", rootfs, path);
    return -1;
  }
  return 0;
}

static int bind_rootfs_path(const char *rootfs, const char *path) {
  char source[PATH_MAX];
  if (rootfs_source_path(rootfs, path, source) != 0) return -1;

  return bind_mount(source, path, 1);
}

static int rootfs_path_exists(const char *rootfs, const char *path) {
  char source[PATH_MAX];
  if (rootfs_source_path(rootfs, path, source) != 0) return -1;
  if (access(source, F_OK) == 0) return 1;
  if (errno == ENOENT) return 0;
  fprintf(stderr, "checking rootfs path %s failed: %s\n", source, strerror(errno));
  return -1;
}

static int ensure_directory(const char *path) {
  char current[PATH_MAX];
  size_t length = strlen(path);
  if (length == 0 || length >= sizeof(current)) {
    fprintf(stderr, "mount target path is invalid or too long: %s\n", path);
    return -1;
  }

  memcpy(current, path, length + 1);
  for (char *cursor = current + 1; *cursor != '\0'; cursor++) {
    if (*cursor != '/') continue;
    *cursor = '\0';
    if (mkdir(current, 0755) != 0 && errno != EEXIST) {
      fprintf(stderr, "creating mount target %s failed: %s\n", current, strerror(errno));
      return -1;
    }
    *cursor = '/';
  }

  if (mkdir(current, 0755) != 0 && errno != EEXIST) {
    fprintf(stderr, "creating mount target %s failed: %s\n", current, strerror(errno));
    return -1;
  }
  return 0;
}

static int ensure_file(const char *path) {
  int fd = open(path, O_CREAT | O_CLOEXEC, 0644);
  if (fd < 0) {
    fprintf(stderr, "creating mount target %s failed: %s\n", path, strerror(errno));
    return -1;
  }
  if (close(fd) != 0) {
    fprintf(stderr, "closing mount target %s failed: %s\n", path, strerror(errno));
    return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: sandbox-rootfs-setup ROOTFS [COMMAND ...]\n");
    return 2;
  }

  const char *rootfs = argv[1];
  if (rootfs[0] != '/') {
    fprintf(stderr, "rootfs must be an absolute path\n");
    return 2;
  }

  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) {
    fprintf(stderr, "making the mount namespace private failed: %s\n", strerror(errno));
    return 1;
  }

  if ((mkdir("/sandbox_api", 0755) != 0 && errno != EEXIST) ||
      (mkdir("/pkgs", 0755) != 0 && errno != EEXIST)) {
    fprintf(stderr, "creating rootfs mount targets failed: %s\n", strerror(errno));
    return 1;
  }

  /*
   * Keep this process statically linked: the final /usr mount replaces
   * the Fedora launcher's dynamic userspace with the Debian sandbox rootfs.
   * A shell cannot safely perform this sequence because its next command may
   * try to load a host binary against guest libraries (or vice versa).
   */
  const char *paths[] = {"/sandbox_api", "/pkgs"};
  for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); i++) {
    if (bind_rootfs_path(rootfs, paths[i]) != 0) {
      return 1;
    }
  }

  if (access("/host-packages", F_OK) == 0 &&
      bind_mount("/host-packages", "/pkgs", 0) != 0) {
    fprintf(stderr, "warning: sandbox will run without host packages\n");
  }

  /*
   * Preserve the outer container's live /etc (notably Docker-managed DNS),
   * while exposing the narrow Debian configuration and caches consumed by
   * document binaries after /usr is replaced.
   */
  const char *resource_directories[] = {
      "/etc/alternatives",
      "/etc/fonts",
      "/etc/ImageMagick-6",
      "/etc/ImageMagick-7",
      "/etc/libreoffice",
  };
  for (size_t i = 0;
       i < sizeof(resource_directories) / sizeof(resource_directories[0]);
       i++) {
    int exists = rootfs_path_exists(rootfs, resource_directories[i]);
    if (exists < 0) return 1;
    if (exists == 0) continue;
    if (ensure_directory(resource_directories[i]) != 0 ||
        bind_rootfs_path(rootfs, resource_directories[i]) != 0) {
      return 1;
    }
  }

  if (ensure_directory("/var/cache/fontconfig") != 0 ||
      bind_rootfs_path(rootfs, "/var/cache/fontconfig") != 0) {
    return 1;
  }

  int ld_cache_exists = rootfs_path_exists(rootfs, "/etc/ld.so.cache");
  if (ld_cache_exists < 0) return 1;
  if (ld_cache_exists > 0 &&
      (ensure_file("/etc/ld.so.cache") != 0 ||
       bind_rootfs_path(rootfs, "/etc/ld.so.cache") != 0)) {
    return 1;
  }

  /* Bind all guest userspace last, then immediately enter it. */
  if (bind_rootfs_path(rootfs, "/usr") != 0) {
    return 1;
  }

  setenv("PATH", "/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", 1);

  /*
   * Do not carry a launcher-specific library search path into the guest.
   * Guest binaries resolve standard libraries through the mounted linker
   * cache, and applications such as LibreOffice add their own private library
   * directories in their wrappers.
   */
  unsetenv("LD_LIBRARY_PATH");

  setenv("NSJAIL_PATH", "/usr/sbin/nsjail", 1);

  char *default_argv[] = {"/sandbox_api/entrypoint.sh", NULL};
  char **command_argv = argc > 2 ? &argv[2] : default_argv;
  execv(command_argv[0], command_argv);
  fprintf(stderr, "starting sandbox entrypoint failed: %s\n", strerror(errno));
  return 1;
}
