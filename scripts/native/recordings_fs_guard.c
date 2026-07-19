#define _DARWIN_C_SOURCE 1
#define _GNU_SOURCE 1
#include <node_api.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdbool.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/acl.h>
#elif defined(__linux__)
#include <sys/xattr.h>
#endif
#ifdef __linux__
#include <sys/syscall.h>
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

typedef struct {
  int fd;
  int closed;
} recordings_handle;

typedef struct {
  uint32_t state[8];
  uint64_t bit_count;
  unsigned char buffer[64];
  size_t buffer_length;
} sha256_context;

static uint32_t rotate_right(uint32_t value, uint32_t count) {
  return (value >> count) | (value << (32U - count));
}

static void sha256_transform(sha256_context *context, const unsigned char block[64]) {
  static const uint32_t constants[64] = {
    0x428a2f98U,0x71374491U,0xb5c0fbcfU,0xe9b5dba5U,0x3956c25bU,0x59f111f1U,0x923f82a4U,0xab1c5ed5U,
    0xd807aa98U,0x12835b01U,0x243185beU,0x550c7dc3U,0x72be5d74U,0x80deb1feU,0x9bdc06a7U,0xc19bf174U,
    0xe49b69c1U,0xefbe4786U,0x0fc19dc6U,0x240ca1ccU,0x2de92c6fU,0x4a7484aaU,0x5cb0a9dcU,0x76f988daU,
    0x983e5152U,0xa831c66dU,0xb00327c8U,0xbf597fc7U,0xc6e00bf3U,0xd5a79147U,0x06ca6351U,0x14292967U,
    0x27b70a85U,0x2e1b2138U,0x4d2c6dfcU,0x53380d13U,0x650a7354U,0x766a0abbU,0x81c2c92eU,0x92722c85U,
    0xa2bfe8a1U,0xa81a664bU,0xc24b8b70U,0xc76c51a3U,0xd192e819U,0xd6990624U,0xf40e3585U,0x106aa070U,
    0x19a4c116U,0x1e376c08U,0x2748774cU,0x34b0bcb5U,0x391c0cb3U,0x4ed8aa4aU,0x5b9cca4fU,0x682e6ff3U,
    0x748f82eeU,0x78a5636fU,0x84c87814U,0x8cc70208U,0x90befffaU,0xa4506cebU,0xbef9a3f7U,0xc67178f2U,
  };
  uint32_t words[64];
  for (size_t index = 0; index < 16; index++) {
    words[index] = ((uint32_t)block[index * 4] << 24) |
      ((uint32_t)block[index * 4 + 1] << 16) |
      ((uint32_t)block[index * 4 + 2] << 8) |
      (uint32_t)block[index * 4 + 3];
  }
  for (size_t index = 16; index < 64; index++) {
    uint32_t s0 = rotate_right(words[index - 15], 7) ^ rotate_right(words[index - 15], 18) ^
      (words[index - 15] >> 3);
    uint32_t s1 = rotate_right(words[index - 2], 17) ^ rotate_right(words[index - 2], 19) ^
      (words[index - 2] >> 10);
    words[index] = words[index - 16] + s0 + words[index - 7] + s1;
  }
  uint32_t a=context->state[0], b=context->state[1], c=context->state[2], d=context->state[3];
  uint32_t e=context->state[4], f=context->state[5], g=context->state[6], h=context->state[7];
  for (size_t index = 0; index < 64; index++) {
    uint32_t s1=rotate_right(e,6)^rotate_right(e,11)^rotate_right(e,25);
    uint32_t choice=(e&f)^((~e)&g);
    uint32_t temporary1=h+s1+choice+constants[index]+words[index];
    uint32_t s0=rotate_right(a,2)^rotate_right(a,13)^rotate_right(a,22);
    uint32_t majority=(a&b)^(a&c)^(b&c);
    uint32_t temporary2=s0+majority;
    h=g; g=f; f=e; e=d+temporary1; d=c; c=b; b=a; a=temporary1+temporary2;
  }
  context->state[0]+=a; context->state[1]+=b; context->state[2]+=c; context->state[3]+=d;
  context->state[4]+=e; context->state[5]+=f; context->state[6]+=g; context->state[7]+=h;
}

static void sha256_init(sha256_context *context) {
  static const uint32_t initial[8] = {
    0x6a09e667U,0xbb67ae85U,0x3c6ef372U,0xa54ff53aU,
    0x510e527fU,0x9b05688cU,0x1f83d9abU,0x5be0cd19U,
  };
  memcpy(context->state, initial, sizeof(initial));
  context->bit_count = 0;
  context->buffer_length = 0;
}

static void sha256_update(sha256_context *context, const unsigned char *bytes, size_t length) {
  context->bit_count += (uint64_t)length * 8U;
  while (length > 0) {
    size_t available = 64 - context->buffer_length;
    size_t count = length < available ? length : available;
    memcpy(context->buffer + context->buffer_length, bytes, count);
    context->buffer_length += count;
    bytes += count;
    length -= count;
    if (context->buffer_length == 64) {
      sha256_transform(context, context->buffer);
      context->buffer_length = 0;
    }
  }
}

static void sha256_final(sha256_context *context, unsigned char digest[32]) {
  uint64_t original_bits = context->bit_count;
  unsigned char one = 0x80;
  unsigned char zero = 0;
  sha256_update(context, &one, 1);
  while (context->buffer_length != 56) sha256_update(context, &zero, 1);
  unsigned char length[8];
  for (size_t index = 0; index < 8; index++) length[7 - index] = (unsigned char)(original_bits >> (index * 8));
  sha256_update(context, length, 8);
  for (size_t index = 0; index < 8; index++) {
    digest[index*4]=(unsigned char)(context->state[index]>>24);
    digest[index*4+1]=(unsigned char)(context->state[index]>>16);
    digest[index*4+2]=(unsigned char)(context->state[index]>>8);
    digest[index*4+3]=(unsigned char)context->state[index];
  }
}

static void throw_errno(napi_env env, const char *operation) {
  char code[32];
  char message[320];
  snprintf(code, sizeof(code), "ERRNO_%d", errno);
  snprintf(message, sizeof(message), "%s failed: %s", operation, strerror(errno));
  napi_throw_error(env, code, message);
}

static void throw_message(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
}

static int check_napi(napi_env env, napi_status status, const char *operation) {
  if (status == napi_ok) return 1;
  const napi_extended_error_info *info = NULL;
  napi_get_last_error_info(env, &info);
  napi_throw_error(env, "NAPI_ERROR", info && info->error_message ? info->error_message : operation);
  return 0;
}

static void finalize_handle(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  recordings_handle *handle = (recordings_handle *)data;
  if (handle != NULL) {
    if (!handle->closed && handle->fd >= 0) close(handle->fd);
    free(handle);
  }
}

static napi_value make_handle(napi_env env, int fd) {
  napi_value object;
  recordings_handle *handle = calloc(1, sizeof(*handle));
  if (handle == NULL) {
    close(fd);
    throw_message(env, "ENOMEM", "could not allocate native filesystem handle");
    return NULL;
  }
  handle->fd = fd;
  if (!check_napi(env, napi_create_object(env, &object), "create handle") ||
      !check_napi(env, napi_wrap(env, object, handle, finalize_handle, NULL, NULL), "wrap handle")) {
    finalize_handle(env, handle, NULL);
    return NULL;
  }
  return object;
}

static recordings_handle *get_handle(napi_env env, napi_value value) {
  recordings_handle *handle = NULL;
  if (!check_napi(env, napi_unwrap(env, value, (void **)&handle), "unwrap handle")) return NULL;
  if (handle == NULL || handle->closed || handle->fd < 0) {
    throw_message(env, "HANDLE_CLOSED", "native filesystem handle is closed");
    return NULL;
  }
  return handle;
}

static char *get_string(napi_env env, napi_value value, const char *label) {
  size_t length = 0;
  if (!check_napi(env, napi_get_value_string_utf8(env, value, NULL, 0, &length), label)) return NULL;
  char *result = malloc(length + 1);
  if (result == NULL) {
    throw_message(env, "ENOMEM", "could not allocate native string");
    return NULL;
  }
  size_t written = 0;
  if (!check_napi(env, napi_get_value_string_utf8(env, value, result, length + 1, &written), label)) {
    free(result);
    return NULL;
  }
  if (written != length || memchr(result, '\0', length) != NULL) {
    free(result);
    throw_message(env, "INVALID_PATH", "native path contains an embedded NUL");
    return NULL;
  }
  return result;
}

static int valid_leaf(const char *leaf) {
  return leaf != NULL && leaf[0] != '\0' && strcmp(leaf, ".") != 0 &&
    strcmp(leaf, "..") != 0 && strchr(leaf, '/') == NULL;
}

static char *get_leaf(napi_env env, napi_value value) {
  char *leaf = get_string(env, value, "read path leaf");
  if (leaf != NULL && !valid_leaf(leaf)) {
    free(leaf);
    throw_message(env, "INVALID_LEAF", "native filesystem leaf must be one non-dot path component");
    return NULL;
  }
  return leaf;
}

static int get_uint32(napi_env env, napi_value value, uint32_t *result, const char *label) {
  return check_napi(env, napi_get_value_uint32(env, value, result), label);
}

static napi_value make_boolean(napi_env env, int value) {
  napi_value result;
  if (!check_napi(env, napi_get_boolean(env, value != 0, &result), "create boolean")) return NULL;
  return result;
}

static const char *stat_type(const struct stat *details) {
  if (S_ISREG(details->st_mode)) return "file";
  if (S_ISDIR(details->st_mode)) return "directory";
  if (S_ISLNK(details->st_mode)) return "symlink";
  return "special";
}

static napi_value metadata_value(napi_env env, const struct stat *details) {
  napi_value object, value;
  if (!check_napi(env, napi_create_object(env, &object), "create metadata")) return NULL;
#define SET_BIGINT(name, number) \
  do { \
    if (!check_napi(env, napi_create_bigint_uint64(env, (uint64_t)(number), &value), "create bigint") || \
        !check_napi(env, napi_set_named_property(env, object, (name), value), "set bigint")) return NULL; \
  } while (0)
#define SET_UINT(name, number) \
  do { \
    if (!check_napi(env, napi_create_uint32(env, (uint32_t)(number), &value), "create uint") || \
        !check_napi(env, napi_set_named_property(env, object, (name), value), "set uint")) return NULL; \
  } while (0)
  SET_BIGINT("dev", details->st_dev);
  SET_BIGINT("ino", details->st_ino);
  SET_BIGINT("size", details->st_size);
  SET_UINT("uid", details->st_uid);
  SET_UINT("mode", details->st_mode & 07777);
  SET_UINT("nlink", details->st_nlink);
  if (!check_napi(env, napi_create_string_utf8(env, stat_type(details), NAPI_AUTO_LENGTH, &value), "create type") ||
      !check_napi(env, napi_set_named_property(env, object, "type", value), "set type")) return NULL;
#undef SET_BIGINT
#undef SET_UINT
  return object;
}

static napi_value open_trusted_home(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  size_t argc = 2;
  uint32_t expected_uid;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "openTrustedHome args") || argc != 2 ||
      !get_uint32(env, argv[1], &expected_uid, "read expected uid")) return NULL;
  char *path = get_string(env, argv[0], "read trusted home path");
  if (path == NULL) return NULL;
  size_t length = strlen(path);
  if (path[0] != '/' || length < 2 || path[length - 1] == '/' || strstr(path, "//") != NULL) {
    free(path);
    throw_message(env, "INVALID_HOME", "trusted home must be a canonical absolute non-root path");
    return NULL;
  }
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    free(path);
    throw_errno(env, "open root");
    return NULL;
  }
  char *cursor = path + 1;
  char *save = NULL;
  for (char *component = strtok_r(cursor, "/", &save); component != NULL;
       component = strtok_r(NULL, "/", &save)) {
    if (!valid_leaf(component)) {
      close(fd);
      free(path);
      throw_message(env, "INVALID_HOME", "trusted home contains an unsafe component");
      return NULL;
    }
    int next = openat(fd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) {
      close(fd);
      free(path);
      throw_errno(env, "open trusted home component");
      return NULL;
    }
    close(fd);
    fd = next;
  }
  free(path);
  struct stat details;
  if (fstat(fd, &details) != 0 || !S_ISDIR(details.st_mode) || details.st_uid != (uid_t)expected_uid) {
    if (errno == 0) errno = EPERM;
    close(fd);
    throw_errno(env, "validate trusted home");
    return NULL;
  }
  return make_handle(env, fd);
}

static napi_value open_dir_at(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  size_t argc = 2;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "openDirAt args") || argc != 2) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  if (parent == NULL || leaf == NULL) { free(leaf); return NULL; }
  int fd = openat(parent->fd, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  free(leaf);
  if (fd < 0) { throw_errno(env, "open directory at capability"); return NULL; }
  return make_handle(env, fd);
}

static napi_value open_regular_at(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "openRegularAt args") || argc != 3) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  char *access = get_string(env, argv[2], "read regular access");
  if (parent == NULL || leaf == NULL || access == NULL) { free(leaf); free(access); return NULL; }
  int flags;
  mode_t mode = 0600;
  if (strcmp(access, "read") == 0) flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC;
  else if (strcmp(access, "createExclusive") == 0) {
    flags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC;
  } else {
    free(leaf); free(access);
    throw_message(env, "INVALID_ACCESS", "regular access must be read or createExclusive");
    return NULL;
  }
  int fd = openat(parent->fd, leaf, flags, mode);
  free(leaf); free(access);
  if (fd < 0) { throw_errno(env, "open regular file at capability"); return NULL; }
  struct stat details;
  if (fstat(fd, &details) != 0 || !S_ISREG(details.st_mode)) {
    if (errno == 0) errno = EINVAL;
    close(fd);
    throw_errno(env, "validate regular file at capability");
    return NULL;
  }
  return make_handle(env, fd);
}

static napi_value read_dir(napi_env env, napi_callback_info info) {
  napi_value argv[1], array;
  size_t argc = 1;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "readDir args") || argc != 1) return NULL;
  recordings_handle *directory = get_handle(env, argv[0]);
  if (directory == NULL) return NULL;
  int iterator_fd = openat(directory->fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (iterator_fd < 0) { throw_errno(env, "reopen directory capability"); return NULL; }
  DIR *stream = fdopendir(iterator_fd);
  if (stream == NULL) { close(iterator_fd); throw_errno(env, "open directory stream"); return NULL; }
  if (!check_napi(env, napi_create_array(env, &array), "create directory array")) { closedir(stream); return NULL; }
  uint32_t index = 0;
  errno = 0;
  for (struct dirent *entry = readdir(stream); entry != NULL; entry = readdir(stream)) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (!valid_leaf(entry->d_name)) {
      closedir(stream);
      throw_message(env, "INVALID_DIRENT", "directory returned an unsafe entry name");
      return NULL;
    }
    napi_value name;
    if (!check_napi(env, napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name), "create entry name") ||
        !check_napi(env, napi_set_element(env, array, index++, name), "append entry name")) {
      closedir(stream);
      return NULL;
    }
  }
  int saved_errno = errno;
  closedir(stream);
  if (saved_errno != 0) { errno = saved_errno; throw_errno(env, "read directory capability"); return NULL; }
  return array;
}

static napi_value stat_handle(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "statHandle args") || argc != 1) return NULL;
  recordings_handle *handle = get_handle(env, argv[0]);
  struct stat details;
  if (handle == NULL) return NULL;
  if (fstat(handle->fd, &details) != 0) { throw_errno(env, "stat capability"); return NULL; }
  return metadata_value(env, &details);
}

static napi_value stat_at(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  size_t argc = 2;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "statAt args") || argc != 2) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  if (parent == NULL || leaf == NULL) { free(leaf); return NULL; }
  struct stat details;
  int result = fstatat(parent->fd, leaf, &details, AT_SYMLINK_NOFOLLOW);
  free(leaf);
  if (result != 0 && errno == ENOENT) {
    napi_value null_value;
    napi_get_null(env, &null_value);
    return null_value;
  }
  if (result != 0) { throw_errno(env, "stat at capability"); return NULL; }
  return metadata_value(env, &details);
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  uint32_t mode;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "mkdirAt args") || argc != 3 ||
      !get_uint32(env, argv[2], &mode, "read directory mode")) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  if (parent == NULL || leaf == NULL) { free(leaf); return NULL; }
  if (mkdirat(parent->fd, leaf, (mode_t)(mode & 0777)) != 0) {
    free(leaf); throw_errno(env, "create directory at capability"); return NULL;
  }
  int fd = openat(parent->fd, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    int saved_errno = errno;
    unlinkat(parent->fd, leaf, AT_REMOVEDIR);
    free(leaf); errno = saved_errno; throw_errno(env, "open created directory at capability"); return NULL;
  }
  if (fchmod(fd, (mode_t)(mode & 0777)) != 0 || fsync(fd) != 0) {
    int saved_errno = errno;
    close(fd); unlinkat(parent->fd, leaf, AT_REMOVEDIR);
    free(leaf); errno = saved_errno; throw_errno(env, "secure created directory at capability"); return NULL;
  }
  free(leaf);
  return make_handle(env, fd);
}

static int unwrap_two_parents_and_leaves(
  napi_env env, napi_callback_info info, recordings_handle **left_parent, char **left_leaf,
  recordings_handle **right_parent, char **right_leaf) {
  napi_value argv[4];
  size_t argc = 4;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "filesystem operation args") || argc != 4) return 0;
  *left_parent = get_handle(env, argv[0]);
  *left_leaf = get_leaf(env, argv[1]);
  *right_parent = get_handle(env, argv[2]);
  *right_leaf = get_leaf(env, argv[3]);
  if (*left_parent == NULL || *left_leaf == NULL || *right_parent == NULL || *right_leaf == NULL) {
    free(*left_leaf); free(*right_leaf); return 0;
  }
  return 1;
}

static napi_value link_no_replace_at(napi_env env, napi_callback_info info) {
  recordings_handle *source_parent, *destination_parent;
  char *source_leaf = NULL, *destination_leaf = NULL;
  if (!unwrap_two_parents_and_leaves(env, info, &source_parent, &source_leaf,
      &destination_parent, &destination_leaf)) return NULL;
  int result = linkat(source_parent->fd, source_leaf, destination_parent->fd, destination_leaf, 0);
  int saved_errno = errno;
  free(source_leaf); free(destination_leaf);
  if (result == 0) return make_boolean(env, 1);
  if (saved_errno == EEXIST) return make_boolean(env, 0);
  errno = saved_errno; throw_errno(env, "link without replacement at capability"); return NULL;
}

static int rename_no_replace(int source_parent_fd, const char *source_leaf,
    int destination_parent_fd, const char *destination_leaf) {
#ifdef __APPLE__
  return renameatx_np(source_parent_fd, source_leaf, destination_parent_fd,
    destination_leaf, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, source_parent_fd, source_leaf,
    destination_parent_fd, destination_leaf, 1U);
#else
  errno = ENOTSUP;
  return -1;
#endif
}

static napi_value rename_no_replace_at(napi_env env, napi_callback_info info) {
  recordings_handle *source_parent, *destination_parent;
  char *source_leaf = NULL, *destination_leaf = NULL;
  if (!unwrap_two_parents_and_leaves(env, info, &source_parent, &source_leaf,
      &destination_parent, &destination_leaf)) return NULL;
  int result = rename_no_replace(source_parent->fd, source_leaf,
    destination_parent->fd, destination_leaf);
  int saved_errno = errno;
  free(source_leaf); free(destination_leaf);
  if (result != 0) { errno = saved_errno; throw_errno(env, "rename without replacement at capability"); return NULL; }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value rename_handle_no_replace_at(napi_env env, napi_callback_info info) {
  napi_value argv[5];
  size_t argc = 5;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL),
      "renameHandleNoReplaceAt args") || argc != 5) return NULL;
  recordings_handle *source_parent = get_handle(env, argv[0]);
  char *source_leaf = get_leaf(env, argv[1]);
  recordings_handle *source = get_handle(env, argv[2]);
  recordings_handle *destination_parent = get_handle(env, argv[3]);
  char *destination_leaf = get_leaf(env, argv[4]);
  if (source_parent == NULL || source_leaf == NULL || source == NULL ||
      destination_parent == NULL || destination_leaf == NULL) {
    free(source_leaf); free(destination_leaf); return NULL;
  }
  struct stat opened, named;
  int valid_source = fstat(source->fd, &opened) == 0 &&
    fstatat(source_parent->fd, source_leaf, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
    opened.st_dev == named.st_dev && opened.st_ino == named.st_ino;
  if (!valid_source) {
    free(source_leaf); free(destination_leaf); errno = ESTALE;
    throw_errno(env, "retained rename source binding"); return NULL;
  }
  int result = rename_no_replace(source_parent->fd, source_leaf,
    destination_parent->fd, destination_leaf);
  int saved_errno = errno;
  int valid_destination = result == 0 &&
    fstatat(destination_parent->fd, destination_leaf, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
    opened.st_dev == named.st_dev && opened.st_ino == named.st_ino;
  if (result == 0 && !valid_destination) {
    struct stat rebound, rollback_destination;
    int source_missing =
      fstatat(source_parent->fd, source_leaf, &rebound, AT_SYMLINK_NOFOLLOW) != 0 &&
      errno == ENOENT;
    int destination_still_retained = source_missing &&
      fstatat(destination_parent->fd, destination_leaf, &rollback_destination,
        AT_SYMLINK_NOFOLLOW) == 0 &&
      opened.st_dev == rollback_destination.st_dev &&
      opened.st_ino == rollback_destination.st_ino;
    if (destination_still_retained) {
      (void)rename_no_replace(destination_parent->fd, destination_leaf,
        source_parent->fd, source_leaf);
    }
  }
  free(source_leaf); free(destination_leaf);
  if (result != 0 || !valid_destination) {
    errno = result != 0 ? saved_errno : ESTALE;
    throw_errno(env, "rename retained source without replacement at capability");
    return NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value rename_replace_at(napi_env env, napi_callback_info info) {
  recordings_handle *source_parent, *destination_parent;
  char *source_leaf = NULL, *destination_leaf = NULL;
  if (!unwrap_two_parents_and_leaves(env, info, &source_parent, &source_leaf,
      &destination_parent, &destination_leaf)) return NULL;
  int result = renameat(source_parent->fd, source_leaf, destination_parent->fd, destination_leaf);
  int saved_errno = errno;
  free(source_leaf); free(destination_leaf);
  if (result != 0) { errno = saved_errno; throw_errno(env, "rename with replacement at capability"); return NULL; }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value unlink_at_common(napi_env env, napi_callback_info info, int flags) {
  napi_value argv[2];
  size_t argc = 2;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "unlinkAt args") || argc != 2) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  if (parent == NULL || leaf == NULL) { free(leaf); return NULL; }
  int result = unlinkat(parent->fd, leaf, flags);
  int saved_errno = errno;
  free(leaf);
  if (result != 0) { errno = saved_errno; throw_errno(env, "unlink at capability"); return NULL; }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value unlink_file_at(napi_env env, napi_callback_info info) {
  return unlink_at_common(env, info, 0);
}

static napi_value unlink_dir_at(napi_env env, napi_callback_info info) {
  return unlink_at_common(env, info, AT_REMOVEDIR);
}

static napi_value same_binding(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "sameBinding args") || argc != 3) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  recordings_handle *child = get_handle(env, argv[2]);
  if (parent == NULL || leaf == NULL || child == NULL) { free(leaf); return NULL; }
  struct stat named, opened;
  int named_result = fstatat(parent->fd, leaf, &named, AT_SYMLINK_NOFOLLOW);
  int opened_result = fstat(child->fd, &opened);
  free(leaf);
  if (named_result != 0 && errno == ENOENT) return make_boolean(env, 0);
  if (named_result != 0 || opened_result != 0) { throw_errno(env, "compare capability binding"); return NULL; }
  return make_boolean(env, named.st_dev == opened.st_dev && named.st_ino == opened.st_ino);
}

static napi_value fsync_handle(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "fsyncHandle args") || argc != 1) return NULL;
  recordings_handle *handle = get_handle(env, argv[0]);
  if (handle == NULL) return NULL;
  if (fsync(handle->fd) != 0) { throw_errno(env, "fsync capability"); return NULL; }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value handle_has_no_extended_acl(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL),
      "handleHasNoExtendedAcl args") || argc != 1) return NULL;
  recordings_handle *handle = get_handle(env, argv[0]);
  if (handle == NULL) return NULL;
#ifdef __APPLE__
  errno = 0;
  acl_t acl = acl_get_fd_np(handle->fd, ACL_TYPE_EXTENDED);
  if (acl == NULL) return make_boolean(env, errno == ENOENT);
  (void)acl_free(acl);
  return make_boolean(env, 0);
#elif defined(__linux__)
  errno = 0;
  ssize_t length = flistxattr(handle->fd, NULL, 0);
  if (length < 0) return make_boolean(env, 0);
  if (length == 0) return make_boolean(env, 1);
  char *names = malloc((size_t)length);
  if (names == NULL) return make_boolean(env, 0);
  ssize_t read_length = flistxattr(handle->fd, names, (size_t)length);
  if (read_length != length) {
    free(names);
    return make_boolean(env, 0);
  }
  int safe = 1;
  for (ssize_t offset = 0; offset < length;) {
    size_t remaining = (size_t)(length - offset);
    size_t name_length = strnlen(names + offset, remaining);
    if (name_length == remaining) { safe = 0; break; }
    if (strcmp(names + offset, "system.posix_acl_access") == 0 ||
        strcmp(names + offset, "system.posix_acl_default") == 0) {
      safe = 0;
      break;
    }
    offset += (ssize_t)name_length + 1;
  }
  free(names);
  return make_boolean(env, safe);
#else
  return make_boolean(env, 0);
#endif
}

static napi_value chmod_handle(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  size_t argc = 2;
  uint32_t mode;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "chmodHandle args") || argc != 2 ||
      !get_uint32(env, argv[1], &mode, "read handle mode")) return NULL;
  recordings_handle *handle = get_handle(env, argv[0]);
  if (handle == NULL) return NULL;
  if (fchmod(handle->fd, (mode_t)(mode & 0777)) != 0 || fsync(handle->fd) != 0) {
    throw_errno(env, "chmod capability"); return NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static int get_boolean(napi_env env, napi_value value, bool *result, const char *label) {
  return check_napi(env, napi_get_value_bool(env, value, result), label);
}

static napi_value write_file_at(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  size_t argc = 4;
  uint32_t mode;
  void *bytes = NULL;
  size_t length = 0;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "writeFileAt args") || argc != 4 ||
      !check_napi(env, napi_get_buffer_info(env, argv[2], &bytes, &length), "read write buffer") ||
      !get_uint32(env, argv[3], &mode, "read file mode")) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  if (parent == NULL || leaf == NULL) { free(leaf); return NULL; }
  int fd = openat(parent->fd, leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    (mode_t)(mode & 0777));
  int saved_errno = errno;
  free(leaf);
  if (fd < 0) { errno = saved_errno; throw_errno(env, "create file at capability"); return NULL; }
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, (const unsigned char *)bytes + offset, length - offset);
    if (count <= 0) {
      saved_errno = errno == 0 ? EIO : errno;
      close(fd); errno = saved_errno; throw_errno(env, "write file at capability"); return NULL;
    }
    offset += (size_t)count;
  }
  if (fsync(fd) != 0) {
    saved_errno = errno; close(fd); errno = saved_errno; throw_errno(env, "fsync written file"); return NULL;
  }
  if (close(fd) != 0) { throw_errno(env, "close written file"); return NULL; }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static int open_bound_regular(int parent_fd, const char *leaf, struct stat *before) {
  int fd = openat(parent_fd, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  if (fstat(fd, before) != 0 || !S_ISREG(before->st_mode)) {
    int saved_errno = errno == 0 ? EINVAL : errno;
    close(fd); errno = saved_errno; return -1;
  }
  return fd;
}

static int same_timespec(struct timespec left, struct timespec right) {
  return left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec;
}

static int same_regular_snapshot(const struct stat *before, const struct stat *after) {
#ifdef __APPLE__
  return before->st_dev == after->st_dev && before->st_ino == after->st_ino &&
    before->st_size == after->st_size &&
    same_timespec(before->st_mtimespec, after->st_mtimespec) &&
    same_timespec(before->st_ctimespec, after->st_ctimespec);
#else
  return before->st_dev == after->st_dev && before->st_ino == after->st_ino &&
    before->st_size == after->st_size &&
    same_timespec(before->st_mtim, after->st_mtim) &&
    same_timespec(before->st_ctim, after->st_ctim);
#endif
}

static int regular_still_bound(int parent_fd, const char *leaf, int fd, const struct stat *before) {
  struct stat after, named;
  return fstat(fd, &after) == 0 && fstatat(parent_fd, leaf, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
    same_regular_snapshot(before, &after) &&
    after.st_dev == named.st_dev && after.st_ino == named.st_ino;
}

static napi_value read_regular_at(napi_env env, napi_callback_info info) {
  napi_value argv[3], result;
  size_t argc = 3;
  uint32_t maximum;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "readRegularAt args") || argc != 3 ||
      !get_uint32(env, argv[2], &maximum, "read maximum bytes")) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  if (parent == NULL || leaf == NULL) { free(leaf); return NULL; }
  struct stat before;
  int fd = open_bound_regular(parent->fd, leaf, &before);
  if (fd < 0) { int saved_errno=errno; free(leaf); errno=saved_errno; throw_errno(env,"open bounded regular file"); return NULL; }
  if (before.st_size < 0 || (uint64_t)before.st_size > maximum) {
    close(fd); free(leaf); throw_message(env,"FILE_TOO_LARGE","bounded native file exceeds its size limit"); return NULL;
  }
  void *bytes = NULL;
  if (!check_napi(env, napi_create_buffer(env, (size_t)before.st_size, &bytes, &result), "create bounded file buffer")) {
    close(fd); free(leaf); return NULL;
  }
  size_t offset = 0;
  while (offset < (size_t)before.st_size) {
    ssize_t count = pread(fd, (unsigned char *)bytes + offset, (size_t)before.st_size - offset, (off_t)offset);
    if (count <= 0) {
      int saved_errno=errno==0?EIO:errno; close(fd); free(leaf); errno=saved_errno; throw_errno(env,"read bounded regular file"); return NULL;
    }
    offset += (size_t)count;
  }
  if (!regular_still_bound(parent->fd, leaf, fd, &before)) {
    close(fd); free(leaf); throw_message(env,"BINDING_CHANGED","bounded native file changed while being read"); return NULL;
  }
  close(fd); free(leaf);
  return result;
}

static napi_value sha256_regular_at(napi_env env, napi_callback_info info) {
  napi_value argv[2], result;
  size_t argc = 2;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "sha256RegularAt args") || argc != 2) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  if (parent == NULL || leaf == NULL) { free(leaf); return NULL; }
  struct stat before;
  int fd = open_bound_regular(parent->fd, leaf, &before);
  if (fd < 0) { int saved_errno=errno; free(leaf); errno=saved_errno; throw_errno(env,"open hash input"); return NULL; }
  sha256_context context;
  sha256_init(&context);
  unsigned char buffer[1024 * 1024];
  off_t offset = 0;
  while (offset < before.st_size) {
    size_t requested = (size_t)(before.st_size - offset);
    if (requested > sizeof(buffer)) requested = sizeof(buffer);
    ssize_t count = pread(fd, buffer, requested, offset);
    if (count <= 0) {
      int saved_errno=errno==0?EIO:errno; close(fd); free(leaf); errno=saved_errno; throw_errno(env,"hash regular file"); return NULL;
    }
    sha256_update(&context, buffer, (size_t)count);
    offset += count;
  }
  if (!regular_still_bound(parent->fd, leaf, fd, &before)) {
    close(fd); free(leaf); throw_message(env,"BINDING_CHANGED","hash input changed while being read"); return NULL;
  }
  close(fd); free(leaf);
  unsigned char digest[32];
  char hexadecimal[65];
  static const char alphabet[] = "0123456789abcdef";
  sha256_final(&context, digest);
  for (size_t index = 0; index < 32; index++) {
    hexadecimal[index*2] = alphabet[digest[index] >> 4];
    hexadecimal[index*2+1] = alphabet[digest[index] & 15];
  }
  hexadecimal[64] = '\0';
  if (!check_napi(env, napi_create_string_utf8(env, hexadecimal, 64, &result), "create hash string")) return NULL;
  return result;
}

static napi_value sha256_handle(napi_env env, napi_callback_info info) {
  napi_value argv[1], result;
  size_t argc = 1;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL),
      "sha256Handle args") || argc != 1) return NULL;
  recordings_handle *handle = get_handle(env, argv[0]);
  if (handle == NULL) return NULL;
  struct stat before, after;
  if (fstat(handle->fd, &before) != 0 || !S_ISREG(before.st_mode)) {
    throw_errno(env, "stat retained hash input"); return NULL;
  }
  sha256_context context;
  sha256_init(&context);
  unsigned char buffer[1024 * 1024];
  off_t offset = 0;
  while (offset < before.st_size) {
    size_t requested = (size_t)(before.st_size - offset);
    if (requested > sizeof(buffer)) requested = sizeof(buffer);
    ssize_t count = pread(handle->fd, buffer, requested, offset);
    if (count <= 0) {
      if (errno == 0) errno = EIO;
      throw_errno(env, "hash retained regular file"); return NULL;
    }
    sha256_update(&context, buffer, (size_t)count);
    offset += count;
  }
  if (fstat(handle->fd, &after) != 0 || !same_regular_snapshot(&before, &after)) {
    throw_message(env, "BINDING_CHANGED", "retained hash input changed while being read");
    return NULL;
  }
  unsigned char digest[32];
  char hexadecimal[65];
  static const char alphabet[] = "0123456789abcdef";
  sha256_final(&context, digest);
  for (size_t index = 0; index < 32; index++) {
    hexadecimal[index * 2] = alphabet[digest[index] >> 4];
    hexadecimal[index * 2 + 1] = alphabet[digest[index] & 15];
  }
  hexadecimal[64] = '\0';
  if (!check_napi(env, napi_create_string_utf8(env, hexadecimal, 64, &result),
      "create retained SHA-256 result")) return NULL;
  return result;
}

static napi_value copy_regular_no_replace_at(napi_env env, napi_callback_info info) {
  napi_value argv[7];
  size_t argc = 7;
  bool crash_during = false, crash_after_publish = false;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "copyRegularNoReplaceAt args") || argc != 7 ||
      !get_boolean(env, argv[5], &crash_during, "read copy crash flag") ||
      !get_boolean(env, argv[6], &crash_after_publish, "read publish crash flag")) return NULL;
  recordings_handle *source_parent = get_handle(env, argv[0]);
  char *source_leaf = get_leaf(env, argv[1]);
  recordings_handle *destination_parent = get_handle(env, argv[2]);
  char *destination_leaf = get_leaf(env, argv[3]);
  char *temporary_leaf = get_leaf(env, argv[4]);
  if (source_parent == NULL || destination_parent == NULL || source_leaf == NULL ||
      destination_leaf == NULL || temporary_leaf == NULL) {
    free(source_leaf); free(destination_leaf); free(temporary_leaf); return NULL;
  }
  struct stat destination_details;
  if (fstatat(destination_parent->fd, destination_leaf, &destination_details, AT_SYMLINK_NOFOLLOW) == 0) {
    free(source_leaf); free(destination_leaf); free(temporary_leaf); return make_boolean(env, 0);
  }
  if (errno != ENOENT) {
    int saved_errno = errno;
    free(source_leaf); free(destination_leaf); free(temporary_leaf);
    errno = saved_errno; throw_errno(env, "check recovery destination"); return NULL;
  }
  int source_fd = openat(source_parent->fd, source_leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (source_fd < 0) {
    int saved_errno = errno; free(source_leaf); free(destination_leaf); free(temporary_leaf);
    errno = saved_errno; throw_errno(env, "open recovery source"); return NULL;
  }
  struct stat source_before;
  if (fstat(source_fd, &source_before) != 0 || !S_ISREG(source_before.st_mode)) {
    int saved_errno = errno == 0 ? EINVAL : errno; close(source_fd);
    free(source_leaf); free(destination_leaf); free(temporary_leaf);
    errno = saved_errno; throw_errno(env, "validate recovery source"); return NULL;
  }
  int temporary_fd = openat(destination_parent->fd, temporary_leaf,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (temporary_fd < 0) {
    int saved_errno = errno; close(source_fd);
    free(source_leaf); free(destination_leaf); free(temporary_leaf);
    errno = saved_errno; throw_errno(env, "create recovery temporary"); return NULL;
  }
  unsigned char buffer[65536];
  off_t offset = 0;
  int failure = 0;
  while (offset < source_before.st_size) {
    size_t requested = (size_t)(source_before.st_size - offset);
    if (requested > sizeof(buffer)) requested = sizeof(buffer);
    ssize_t count = pread(source_fd, buffer, requested, offset);
    if (count <= 0) { errno = errno == 0 ? EIO : errno; failure = 1; break; }
    size_t written = 0;
    while (written < (size_t)count) {
      ssize_t result = write(temporary_fd, buffer + written, (size_t)count - written);
      if (result <= 0) { errno = errno == 0 ? EIO : errno; failure = 1; break; }
      written += (size_t)result;
    }
    if (failure) break;
    offset += count;
    if (crash_during && offset < source_before.st_size) kill(getpid(), SIGKILL);
  }
  struct stat source_after, named_source;
  if (!failure && (fstat(source_fd, &source_after) != 0 ||
      fstatat(source_parent->fd, source_leaf, &named_source, AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_regular_snapshot(&source_before, &source_after) ||
      source_after.st_dev != named_source.st_dev ||
      source_after.st_ino != named_source.st_ino)) {
    errno = ESTALE; failure = 1;
  }
  if (!failure && fchmod(temporary_fd, source_before.st_mode & 0777) != 0) failure = 1;
  struct timespec times[2];
#ifdef __APPLE__
  times[0] = source_before.st_atimespec;
  times[1] = source_before.st_mtimespec;
#else
  times[0] = source_before.st_atim;
  times[1] = source_before.st_mtim;
#endif
  if (!failure && futimens(temporary_fd, times) != 0) failure = 1;
  if (!failure && fsync(temporary_fd) != 0) failure = 1;
  int saved_errno = errno;
  close(source_fd);
  close(temporary_fd);
  if (failure) {
    unlinkat(destination_parent->fd, temporary_leaf, 0);
    free(source_leaf); free(destination_leaf); free(temporary_leaf);
    errno = saved_errno == 0 ? EIO : saved_errno; throw_errno(env, "copy recovery file"); return NULL;
  }
  int published = linkat(destination_parent->fd, temporary_leaf,
    destination_parent->fd, destination_leaf, 0) == 0;
  if (!published && errno != EEXIST) {
    saved_errno = errno; unlinkat(destination_parent->fd, temporary_leaf, 0);
    free(source_leaf); free(destination_leaf); free(temporary_leaf);
    errno = saved_errno; throw_errno(env, "publish recovery file"); return NULL;
  }
  if (fsync(destination_parent->fd) != 0) {
    saved_errno = errno; free(source_leaf); free(destination_leaf); free(temporary_leaf);
    errno = saved_errno; throw_errno(env, "fsync recovery parent"); return NULL;
  }
  if (published && crash_after_publish) kill(getpid(), SIGKILL);
  if (unlinkat(destination_parent->fd, temporary_leaf, 0) != 0 || fsync(destination_parent->fd) != 0) {
    saved_errno = errno; free(source_leaf); free(destination_leaf); free(temporary_leaf);
    errno = saved_errno; throw_errno(env, "remove recovery temporary"); return NULL;
  }
  free(source_leaf); free(destination_leaf); free(temporary_leaf);
  return make_boolean(env, published);
}

static napi_value close_handle(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "close args") || argc != 1) return NULL;
  recordings_handle *handle = NULL;
  if (!check_napi(env, napi_unwrap(env, argv[0], (void **)&handle), "unwrap handle")) return NULL;
  if (handle != NULL && !handle->closed) {
    if (close(handle->fd) != 0) { throw_errno(env, "close capability"); return NULL; }
    handle->fd = -1;
    handle->closed = 1;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static int remove_tree_contents(int directory_fd);

static int same_directory_binding(int parent_fd, const char *leaf, int directory_fd) {
  struct stat opened, named;
  if (fstat(directory_fd, &opened) != 0 ||
      fstatat(parent_fd, leaf, &named, AT_SYMLINK_NOFOLLOW) != 0) return 0;
  if (!S_ISDIR(opened.st_mode) || !S_ISDIR(named.st_mode) ||
      opened.st_dev != named.st_dev || opened.st_ino != named.st_ino) {
    errno = ESTALE;
    return 0;
  }
  return 1;
}

static int remove_entry(int parent_fd, const char *leaf) {
  int child_fd = openat(parent_fd, leaf,
    O_RDONLY | O_NONBLOCK | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (child_fd >= 0) {
    if (!same_directory_binding(parent_fd, leaf, child_fd) ||
        remove_tree_contents(child_fd) != 0 ||
        !same_directory_binding(parent_fd, leaf, child_fd)) {
      int saved_errno = errno == 0 ? ESTALE : errno;
      close(child_fd); errno = saved_errno; return -1;
    }
    close(child_fd);
    return unlinkat(parent_fd, leaf, AT_REMOVEDIR);
  }
  if (errno != ENOTDIR) return -1;
  int file_fd = openat(parent_fd, leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (file_fd < 0) return -1;
  struct stat opened, named;
  int valid = fstat(file_fd, &opened) == 0 && S_ISREG(opened.st_mode) &&
    fstatat(parent_fd, leaf, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
    opened.st_dev == named.st_dev && opened.st_ino == named.st_ino;
  close(file_fd);
  if (!valid) { errno = ESTALE; return -1; }
  return unlinkat(parent_fd, leaf, 0);
}

static int remove_tree_contents(int directory_fd) {
  int iterator_fd = openat(directory_fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (iterator_fd < 0) return -1;
  DIR *stream = fdopendir(iterator_fd);
  if (stream == NULL) { close(iterator_fd); return -1; }
  errno = 0;
  for (struct dirent *entry = readdir(stream); entry != NULL; entry = readdir(stream)) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (!valid_leaf(entry->d_name) || remove_entry(directory_fd, entry->d_name) != 0) {
      int saved_errno = errno == 0 ? EINVAL : errno;
      closedir(stream); errno = saved_errno; return -1;
    }
    errno = 0;
  }
  int saved_errno = errno;
  closedir(stream);
  if (saved_errno != 0) { errno = saved_errno; return -1; }
  return 0;
}

static napi_value remove_tree_at(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  size_t argc = 2;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL), "removeTreeAt args") || argc != 2) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  if (parent == NULL || leaf == NULL) { free(leaf); return NULL; }
  int result = remove_entry(parent->fd, leaf);
  int saved_errno = errno;
  free(leaf);
  if (result != 0) { errno = saved_errno; throw_errno(env, "remove tree at capability"); return NULL; }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value remove_tree_handle_at(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL),
      "removeTreeHandleAt args") || argc != 3) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  recordings_handle *directory = get_handle(env, argv[2]);
  if (parent == NULL || leaf == NULL || directory == NULL) { free(leaf); return NULL; }
  int result = 0;
  if (!same_directory_binding(parent->fd, leaf, directory->fd) ||
      remove_tree_contents(directory->fd) != 0 ||
      !same_directory_binding(parent->fd, leaf, directory->fd) ||
      unlinkat(parent->fd, leaf, AT_REMOVEDIR) != 0) result = -1;
  int saved_errno = errno;
  free(leaf);
  if (result != 0) {
    errno = saved_errno == 0 ? ESTALE : saved_errno;
    throw_errno(env, "remove retained tree at capability");
    return NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value unlink_file_handle_at(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  if (!check_napi(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL),
      "unlinkFileHandleAt args") || argc != 3) return NULL;
  recordings_handle *parent = get_handle(env, argv[0]);
  char *leaf = get_leaf(env, argv[1]);
  recordings_handle *file = get_handle(env, argv[2]);
  if (parent == NULL || leaf == NULL || file == NULL) { free(leaf); return NULL; }
  struct stat opened, named;
  int valid = fstat(file->fd, &opened) == 0 && S_ISREG(opened.st_mode) &&
    fstatat(parent->fd, leaf, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISREG(named.st_mode) && opened.st_dev == named.st_dev && opened.st_ino == named.st_ino;
  int result = valid ? unlinkat(parent->fd, leaf, 0) : -1;
  int saved_errno = valid ? errno : ESTALE;
  free(leaf);
  if (result != 0) {
    errno = saved_errno == 0 ? ESTALE : saved_errno;
    throw_errno(env, "unlink retained file at capability"); return NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    { "openTrustedHome", NULL, open_trusted_home, NULL, NULL, NULL, napi_default, NULL },
    { "openDirAt", NULL, open_dir_at, NULL, NULL, NULL, napi_default, NULL },
    { "openRegularAt", NULL, open_regular_at, NULL, NULL, NULL, napi_default, NULL },
    { "readDir", NULL, read_dir, NULL, NULL, NULL, napi_default, NULL },
    { "statHandle", NULL, stat_handle, NULL, NULL, NULL, napi_default, NULL },
    { "statAt", NULL, stat_at, NULL, NULL, NULL, napi_default, NULL },
    { "mkdirAt", NULL, mkdir_at, NULL, NULL, NULL, napi_default, NULL },
    { "linkNoReplaceAt", NULL, link_no_replace_at, NULL, NULL, NULL, napi_default, NULL },
    { "renameNoReplaceAt", NULL, rename_no_replace_at, NULL, NULL, NULL, napi_default, NULL },
    { "renameHandleNoReplaceAt", NULL, rename_handle_no_replace_at, NULL, NULL, NULL, napi_default, NULL },
    { "renameReplaceAt", NULL, rename_replace_at, NULL, NULL, NULL, napi_default, NULL },
    { "unlinkFileAt", NULL, unlink_file_at, NULL, NULL, NULL, napi_default, NULL },
    { "unlinkDirAt", NULL, unlink_dir_at, NULL, NULL, NULL, napi_default, NULL },
    { "sameBinding", NULL, same_binding, NULL, NULL, NULL, napi_default, NULL },
    { "fsyncHandle", NULL, fsync_handle, NULL, NULL, NULL, napi_default, NULL },
    { "handleHasNoExtendedAcl", NULL, handle_has_no_extended_acl, NULL, NULL, NULL, napi_default, NULL },
    { "chmodHandle", NULL, chmod_handle, NULL, NULL, NULL, napi_default, NULL },
    { "writeFileAt", NULL, write_file_at, NULL, NULL, NULL, napi_default, NULL },
    { "readRegularAt", NULL, read_regular_at, NULL, NULL, NULL, napi_default, NULL },
    { "sha256RegularAt", NULL, sha256_regular_at, NULL, NULL, NULL, napi_default, NULL },
    { "sha256Handle", NULL, sha256_handle, NULL, NULL, NULL, napi_default, NULL },
    { "copyRegularNoReplaceAt", NULL, copy_regular_no_replace_at, NULL, NULL, NULL, napi_default, NULL },
    { "removeTreeAt", NULL, remove_tree_at, NULL, NULL, NULL, napi_default, NULL },
    { "removeTreeHandleAt", NULL, remove_tree_handle_at, NULL, NULL, NULL, napi_default, NULL },
    { "unlinkFileHandleAt", NULL, unlink_file_handle_at, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, close_handle, NULL, NULL, NULL, napi_default, NULL },
  };
  if (!check_napi(env, napi_define_properties(env, exports,
      sizeof(properties) / sizeof(properties[0]), properties), "define filesystem guard exports")) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
