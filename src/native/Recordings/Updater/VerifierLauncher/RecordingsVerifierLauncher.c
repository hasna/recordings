#include "RecordingsVerifierLauncher.h"

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <pwd.h>
#include <sandbox.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define VERIFIER_PATH "/Library/PrivilegedHelperTools/com.hasna.recordings.artifact-verifier"
#define PROFILE_PATH "/Library/Application Support/Hasna/Recordings/Trust/artifact-verifier.sb"
#define MAX_PROFILE_BYTES (64 * 1024)
#define CHILD_ARCHIVE_FD 3
#define CHILD_OUTPUT_FD 4
#define OUTPUT_PATH_PREFIX "/Library/Application Support/Hasna/Recordings/Updates/transaction-"
#define OUTPUT_PATH_SUFFIX "/verifier-output"

int recordings_descriptor_has_no_extended_acl(int descriptor) {
    if (descriptor < 0) return 0;
    errno = 0;
    acl_t acl = acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED);
    if (acl == NULL) return errno == ENOENT ? 1 : 0;
    (void)acl_free(acl);
    return 0;
}

static int validate_root_owned_directory_path(const char *path) {
    int descriptor = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (descriptor < 0) return errno;
    struct stat metadata;
    const bool valid = fstat(descriptor, &metadata) == 0 &&
        S_ISDIR(metadata.st_mode) && metadata.st_uid == 0 &&
        (metadata.st_mode & 0022) == 0 &&
        recordings_descriptor_has_no_extended_acl(descriptor);
    close(descriptor);
    return valid ? 0 : EPERM;
}

static int validate_fixed_runtime_ancestry(void) {
    const char *directories[] = {
        "/",
        "/Library",
        "/Library/PrivilegedHelperTools",
        "/Library/Application Support",
        "/Library/Application Support/Hasna",
        "/Library/Application Support/Hasna/Recordings",
        "/Library/Application Support/Hasna/Recordings/Trust",
    };
    for (size_t index = 0; index < sizeof(directories) / sizeof(directories[0]); index += 1) {
        const int status = validate_root_owned_directory_path(directories[index]);
        if (status != 0) return status;
    }
    return 0;
}

static bool ends_with(const char *value, const char *suffix) {
    const size_t value_length = strlen(value);
    const size_t suffix_length = strlen(suffix);
    return value_length >= suffix_length &&
        strcmp(value + value_length - suffix_length, suffix) == 0;
}

int recordings_lookup_verifier_account(
    const char *account_name,
    uid_t *user_id,
    gid_t *group_id
) {
    if (account_name == NULL || user_id == NULL || group_id == NULL) return EINVAL;
    long suggested = sysconf(_SC_GETPW_R_SIZE_MAX);
    if (suggested < 4096) suggested = 4096;
    if (suggested > 1024 * 1024) return EOVERFLOW;
    char *buffer = calloc(1, (size_t)suggested);
    if (buffer == NULL) return ENOMEM;
    struct passwd record;
    struct passwd *result = NULL;
    const int status = getpwnam_r(account_name, &record, buffer, (size_t)suggested, &result);
    if (status != 0 || result == NULL || record.pw_uid == 0 || record.pw_gid == 0 ||
        record.pw_dir == NULL || strcmp(record.pw_dir, "/var/empty") != 0 ||
        record.pw_shell == NULL ||
        (!ends_with(record.pw_shell, "/false") && !ends_with(record.pw_shell, "/nologin"))) {
        free(buffer);
        return status != 0 ? status : EPERM;
    }
    *user_id = record.pw_uid;
    *group_id = record.pw_gid;
    free(buffer);
    return 0;
}

static int open_and_read_profile(char **profile_out) {
    int descriptor = open(PROFILE_PATH, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (descriptor < 0) return errno;
    struct stat metadata;
    if (fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
        metadata.st_uid != 0 || (metadata.st_mode & 0022) != 0 ||
        metadata.st_size <= 0 || metadata.st_size > MAX_PROFILE_BYTES ||
        !recordings_descriptor_has_no_extended_acl(descriptor)) {
        close(descriptor);
        return EPERM;
    }
    char *profile = calloc(1, (size_t)metadata.st_size + 1);
    if (profile == NULL) {
        close(descriptor);
        return ENOMEM;
    }
    off_t offset = 0;
    while (offset < metadata.st_size) {
        const ssize_t count = pread(
            descriptor,
            profile + offset,
            (size_t)(metadata.st_size - offset),
            offset
        );
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) {
            free(profile);
            close(descriptor);
            return EIO;
        }
        offset += count;
    }
    struct stat after;
    if (fstat(descriptor, &after) != 0 || metadata.st_dev != after.st_dev ||
        metadata.st_ino != after.st_ino || metadata.st_size != after.st_size ||
        metadata.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
        metadata.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
        metadata.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec ||
        metadata.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec ||
        !recordings_descriptor_has_no_extended_acl(descriptor)) {
        free(profile);
        close(descriptor);
        return EBUSY;
    }
    close(descriptor);
    *profile_out = profile;
    return 0;
}

static int verify_protected_executable(void) {
    int descriptor = open(VERIFIER_PATH, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (descriptor < 0) return errno;
    struct stat metadata;
    const bool valid = fstat(descriptor, &metadata) == 0 &&
        S_ISREG(metadata.st_mode) && metadata.st_uid == 0 &&
        (metadata.st_mode & 0022) == 0 && metadata.st_nlink == 1 &&
        recordings_descriptor_has_no_extended_acl(descriptor);
    close(descriptor);
    return valid ? 0 : EPERM;
}

static int duplicate_at_least(int descriptor, int minimum) {
    int result;
    do {
        result = fcntl(descriptor, F_DUPFD_CLOEXEC, minimum);
    } while (result < 0 && errno == EINTR);
    return result;
}

static bool is_lower_hex_character(char value) {
    return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
}

static bool is_valid_expected_sha256(const char *value) {
    if (value == NULL || strlen(value) != 64) return false;
    for (size_t index = 0; index < 64; index += 1) {
        if (!is_lower_hex_character(value[index])) return false;
    }
    return true;
}

static bool is_valid_transaction_name(const char *name) {
    const char *prefix = "transaction-";
    const size_t prefix_length = strlen(prefix);
    if (name == NULL || strlen(name) != prefix_length + 36 ||
        strncmp(name, prefix, prefix_length) != 0) return false;
    const char *identifier = name + prefix_length;
    for (size_t index = 0; index < 36; index += 1) {
        const bool hyphen = index == 8 || index == 13 || index == 18 || index == 23;
        if ((hyphen && identifier[index] != '-') ||
            (!hyphen && !is_lower_hex_character(identifier[index]))) return false;
    }
    return true;
}

static bool is_valid_transaction_output_path(const char *path) {
    const size_t prefix_length = strlen(OUTPUT_PATH_PREFIX);
    if (strncmp(path, OUTPUT_PATH_PREFIX, prefix_length) != 0) return false;
    const char *identifier = path + prefix_length;
    for (size_t index = 0; index < 36; index += 1) {
        const bool hyphen = index == 8 || index == 13 || index == 18 || index == 23;
        if ((hyphen && identifier[index] != '-') ||
            (!hyphen && !is_lower_hex_character(identifier[index]))) {
            return false;
        }
    }
    return strcmp(identifier + 36, OUTPUT_PATH_SUFFIX) == 0;
}

static int validate_inherited_descriptors(
    int archive_descriptor,
    int output_directory_descriptor,
    uid_t verifier_user_id,
    gid_t verifier_group_id,
    char output_path[PATH_MAX]
) {
    struct stat archive;
    if (fstat(archive_descriptor, &archive) != 0 || !S_ISREG(archive.st_mode) ||
        archive.st_uid != 0 || (archive.st_mode & 0077) != 0 || archive.st_nlink != 1 ||
        archive.st_size <= 0 ||
        !recordings_descriptor_has_no_extended_acl(archive_descriptor)) {
        return EPERM;
    }
    struct stat output;
    if (fstat(output_directory_descriptor, &output) != 0 || !S_ISDIR(output.st_mode) ||
        output.st_uid != verifier_user_id || output.st_gid != verifier_group_id ||
        (output.st_mode & 0077) != 0 ||
        !recordings_descriptor_has_no_extended_acl(output_directory_descriptor)) {
        return EPERM;
    }
    memset(output_path, 0, PATH_MAX);
    if (fcntl(output_directory_descriptor, F_GETPATH, output_path) != 0 ||
        output_path[0] != '/' || !is_valid_transaction_output_path(output_path)) {
        return EPERM;
    }
    return 0;
}

static bool apply_limit(int resource, rlim_t soft, rlim_t hard) {
    const struct rlimit limit = { .rlim_cur = soft, .rlim_max = hard };
    return setrlimit(resource, &limit) == 0;
}

static void kill_and_reap(pid_t child) {
    kill(child, SIGKILL);
    int wait_status = 0;
    while (waitpid(child, &wait_status, 0) < 0 && errno == EINTR) {}
}

static void verifier_child(
    int archive_descriptor,
    int output_descriptor,
    uid_t user_id,
    gid_t group_id,
    const char *expected_sha256,
    const char *sandbox_profile,
    const char *output_path
) {
    if (!apply_limit(RLIMIT_CPU, 60, 60) ||
        !apply_limit(RLIMIT_AS, 4ULL * 1024 * 1024 * 1024, 4ULL * 1024 * 1024 * 1024) ||
        !apply_limit(RLIMIT_FSIZE, 4ULL * 1024 * 1024 * 1024, 4ULL * 1024 * 1024 * 1024) ||
        !apply_limit(RLIMIT_NOFILE, 32, 32) ||
        !apply_limit(RLIMIT_NPROC, 1, 1)) {
        _exit(70);
    }
    if (dup2(archive_descriptor, CHILD_ARCHIVE_FD) < 0 ||
        dup2(output_descriptor, CHILD_OUTPUT_FD) < 0) {
        _exit(73);
    }
    int null_descriptor = open("/dev/null", O_RDWR | O_CLOEXEC | O_NOFOLLOW);
    if (null_descriptor < 0 || dup2(null_descriptor, STDIN_FILENO) < 0 ||
        dup2(null_descriptor, STDOUT_FILENO) < 0 || dup2(null_descriptor, STDERR_FILENO) < 0) {
        _exit(74);
    }
    if (null_descriptor > CHILD_OUTPUT_FD) close(null_descriptor);
    closefrom(5);

    gid_t groups[] = { group_id };
    if (setgroups(1, groups) != 0 || setgid(group_id) != 0 || setuid(user_id) != 0 ||
        geteuid() != user_id || getegid() != group_id) {
        _exit(71);
    }
    const char *const sandbox_parameters[] = {
        "OUTPUT_DIR", output_path,
        NULL,
    };
    char *sandbox_error = NULL;
    if (sandbox_init_with_parameters(sandbox_profile, 0, sandbox_parameters, &sandbox_error) != 0) {
        if (sandbox_error != NULL) sandbox_free_error(sandbox_error);
        _exit(72);
    }
    // Sandbox initialization is allowed to use implementation-internal descriptors.
    // Re-close everything above the two explicit artifact descriptors before exec.
    closefrom(5);

    char archive_argument[16];
    char output_argument[16];
    snprintf(archive_argument, sizeof(archive_argument), "%d", CHILD_ARCHIVE_FD);
    snprintf(output_argument, sizeof(output_argument), "%d", CHILD_OUTPUT_FD);
    char *const arguments[] = {
        (char *)VERIFIER_PATH,
        (char *)"verify",
        (char *)"--archive-fd",
        archive_argument,
        (char *)"--output-dir-fd",
        output_argument,
        (char *)"--expected-sha256",
        (char *)expected_sha256,
        NULL,
    };
    char *const environment[] = { NULL };
    execve(VERIFIER_PATH, arguments, environment);
    _exit(75);
}

int recordings_run_artifact_verifier(
    int archive_descriptor,
    int output_directory_descriptor,
    uid_t verifier_user_id,
    gid_t verifier_group_id,
    const char *expected_archive_sha256
) {
    if (archive_descriptor < 0 || output_directory_descriptor < 0 ||
        verifier_user_id == 0 || verifier_group_id == 0 ||
        !is_valid_expected_sha256(expected_archive_sha256)) {
        return EINVAL;
    }
    int status = validate_fixed_runtime_ancestry();
    if (status != 0) return status;
    char output_path[PATH_MAX];
    status = validate_inherited_descriptors(
        archive_descriptor,
        output_directory_descriptor,
        verifier_user_id,
        verifier_group_id,
        output_path
    );
    if (status != 0) return status;
    char *sandbox_profile = NULL;
    status = open_and_read_profile(&sandbox_profile);
    if (status != 0) return status;
    status = verify_protected_executable();
    if (status != 0) {
        free(sandbox_profile);
        return status;
    }
    int archive_copy = duplicate_at_least(archive_descriptor, 10);
    int output_copy = duplicate_at_least(output_directory_descriptor, 10);
    if (archive_copy < 0 || output_copy < 0) {
        if (archive_copy >= 0) close(archive_copy);
        if (output_copy >= 0) close(output_copy);
        free(sandbox_profile);
        return errno != 0 ? errno : EMFILE;
    }

    const pid_t child = fork();
    if (child < 0) {
        status = errno;
    } else if (child == 0) {
        verifier_child(
            archive_copy,
            output_copy,
            verifier_user_id,
            verifier_group_id,
            expected_archive_sha256,
            sandbox_profile,
            output_path
        );
    } else {
        struct timespec started;
        if (clock_gettime(CLOCK_MONOTONIC, &started) != 0) {
            kill_and_reap(child);
            status = errno != 0 ? errno : EIO;
        }
        int wait_status = 0;
        while (status == 0) {
            const pid_t waited = waitpid(child, &wait_status, WNOHANG);
            if (waited == child) {
                status = WIFEXITED(wait_status) && WEXITSTATUS(wait_status) == 0 ? 0 : EPROTO;
                break;
            }
            if (waited < 0 && errno != EINTR) {
                const int wait_error = errno;
                kill_and_reap(child);
                status = wait_error != 0 ? wait_error : ECHILD;
                break;
            }
            struct timespec now;
            if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
                const int clock_error = errno;
                kill_and_reap(child);
                status = clock_error != 0 ? clock_error : EIO;
                break;
            }
            if (now.tv_sec - started.tv_sec >= 90) {
                kill_and_reap(child);
                status = ETIMEDOUT;
                break;
            }
            const struct timespec pause = { .tv_sec = 0, .tv_nsec = 100000000 };
            while (nanosleep(&pause, NULL) != 0 && errno == EINTR) {}
        }
    }
    close(archive_copy);
    close(output_copy);
    free(sandbox_profile);
    return status;
}

struct copy_budget {
    uint64_t entries;
    uint64_t bytes;
};

static bool same_stable_binding(const struct stat *before, const struct stat *after) {
    return before->st_dev == after->st_dev && before->st_ino == after->st_ino &&
        before->st_size == after->st_size &&
        before->st_mtimespec.tv_sec == after->st_mtimespec.tv_sec &&
        before->st_mtimespec.tv_nsec == after->st_mtimespec.tv_nsec &&
        before->st_ctimespec.tv_sec == after->st_ctimespec.tv_sec &&
        before->st_ctimespec.tv_nsec == after->st_ctimespec.tv_nsec;
}

static int copy_regular_at(
    int source_parent,
    int destination_parent,
    const char *name,
    uid_t verifier_user_id,
    struct copy_budget *budget
) {
    struct stat named;
    if (fstatat(source_parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISREG(named.st_mode) || named.st_uid != verifier_user_id ||
        named.st_nlink != 1 || (named.st_mode & 0022) != 0 ||
        (named.st_mode & (S_ISUID | S_ISGID | S_ISVTX)) != 0 || named.st_size < 0) {
        return EPERM;
    }
    if (budget->entries >= 100000 ||
        (uint64_t)named.st_size > (4ULL * 1024 * 1024 * 1024) - budget->bytes) {
        return EFBIG;
    }
    budget->entries += 1;
    budget->bytes += (uint64_t)named.st_size;
    int input = openat(source_parent, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (input < 0) return errno;
    struct stat opened;
    if (fstat(input, &opened) != 0 || named.st_dev != opened.st_dev ||
        named.st_ino != opened.st_ino || named.st_size != opened.st_size ||
        !recordings_descriptor_has_no_extended_acl(input)) {
        close(input);
        return EBUSY;
    }
    int output = openat(
        destination_parent,
        name,
        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
        0600
    );
    if (output < 0) {
        int status = errno;
        close(input);
        return status;
    }
    if (!recordings_descriptor_has_no_extended_acl(output)) {
        close(input);
        close(output);
        unlinkat(destination_parent, name, 0);
        return EPERM;
    }
    int status = 0;
    uint8_t *buffer = malloc(1024 * 1024);
    if (buffer == NULL) status = ENOMEM;
    off_t offset = 0;
    while (status == 0 && offset < opened.st_size) {
        size_t requested = (size_t)(opened.st_size - offset);
        if (requested > 1024 * 1024) requested = 1024 * 1024;
        ssize_t count = pread(input, buffer, requested, offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { status = EIO; break; }
        ssize_t written = 0;
        while (written < count) {
            ssize_t chunk = write(output, buffer + written, (size_t)(count - written));
            if (chunk < 0 && errno == EINTR) continue;
            if (chunk <= 0) { status = EIO; break; }
            written += chunk;
        }
        offset += count;
    }
    free(buffer);
    struct stat after;
    if (status == 0 &&
        (fstat(input, &after) != 0 || !same_stable_binding(&opened, &after) ||
         !recordings_descriptor_has_no_extended_acl(input))) {
        status = EBUSY;
    }
    if (status == 0 && fchmod(output, opened.st_mode & 0755) != 0) status = errno;
    if (status == 0 && !recordings_descriptor_has_no_extended_acl(output)) status = EPERM;
    if (status == 0 && fsync(output) != 0) status = errno != 0 ? errno : EIO;
    close(input);
    close(output);
    if (status != 0) unlinkat(destination_parent, name, 0);
    return status;
}

static int copy_directory_at(
    int source_parent,
    int destination_parent,
    const char *name,
    uid_t verifier_user_id,
    struct copy_budget *budget
) {
    struct stat named;
    if (fstatat(source_parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISDIR(named.st_mode) || named.st_uid != verifier_user_id ||
        (named.st_mode & 0022) != 0 ||
        (named.st_mode & (S_ISUID | S_ISGID | S_ISVTX)) != 0) {
        return EPERM;
    }
    if (budget->entries >= 100000) return EFBIG;
    budget->entries += 1;
    int source = openat(source_parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (source < 0) return errno;
    struct stat opened;
    if (fstat(source, &opened) != 0 || named.st_dev != opened.st_dev ||
        named.st_ino != opened.st_ino ||
        !recordings_descriptor_has_no_extended_acl(source)) {
        close(source);
        return EBUSY;
    }
    if (mkdirat(destination_parent, name, 0700) != 0) {
        int status = errno;
        close(source);
        return status;
    }
    int destination = openat(
        destination_parent,
        name,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
    );
    if (destination < 0) {
        int status = errno;
        close(source);
        return status;
    }
    if (!recordings_descriptor_has_no_extended_acl(destination)) {
        close(source);
        close(destination);
        unlinkat(destination_parent, name, AT_REMOVEDIR);
        return EPERM;
    }
    int enumeration_descriptor = duplicate_at_least(source, 10);
    DIR *directory = enumeration_descriptor < 0 ? NULL : fdopendir(enumeration_descriptor);
    int status = directory == NULL ? (errno != 0 ? errno : EIO) : 0;
    if (directory == NULL && enumeration_descriptor >= 0) close(enumeration_descriptor);
    while (status == 0) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (entry == NULL) {
            if (errno != 0) status = errno;
            break;
        }
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (strchr(entry->d_name, '/') != NULL || entry->d_name[0] == '\0') {
            status = EPERM;
            break;
        }
        struct stat child;
        if (fstatat(source, entry->d_name, &child, AT_SYMLINK_NOFOLLOW) != 0) {
            status = errno;
        } else if (S_ISDIR(child.st_mode)) {
            status = copy_directory_at(source, destination, entry->d_name, verifier_user_id, budget);
        } else if (S_ISREG(child.st_mode)) {
            status = copy_regular_at(source, destination, entry->d_name, verifier_user_id, budget);
        } else {
            status = EPERM;
        }
    }
    if (directory != NULL) closedir(directory);
    struct stat after;
    if (status == 0 &&
        (fstat(source, &after) != 0 || !same_stable_binding(&opened, &after) ||
         !recordings_descriptor_has_no_extended_acl(source))) {
        status = EBUSY;
    }
    if (status == 0 && fchmod(destination, opened.st_mode & 0755) != 0) status = errno;
    if (status == 0 && !recordings_descriptor_has_no_extended_acl(destination)) status = EPERM;
    if (status == 0 && fsync(destination) != 0) status = errno != 0 ? errno : EIO;
    close(source);
    close(destination);
    return status;
}

int recordings_copy_canonical_application_tree(
    int verifier_output_directory_descriptor,
    int root_candidate_directory_descriptor,
    uid_t verifier_user_id
) {
    if (verifier_output_directory_descriptor < 0 || root_candidate_directory_descriptor < 0 ||
        verifier_user_id == 0) return EINVAL;
    struct stat source_root;
    struct stat destination_root;
    if (fstat(verifier_output_directory_descriptor, &source_root) != 0 ||
        !S_ISDIR(source_root.st_mode) || source_root.st_uid != 0 ||
        (source_root.st_mode & 0077) != 0 ||
        fstat(root_candidate_directory_descriptor, &destination_root) != 0 ||
        !S_ISDIR(destination_root.st_mode) || destination_root.st_uid != 0 ||
        (destination_root.st_mode & 0077) != 0 ||
        !recordings_descriptor_has_no_extended_acl(verifier_output_directory_descriptor) ||
        !recordings_descriptor_has_no_extended_acl(root_candidate_directory_descriptor)) {
        return EPERM;
    }
    int enumeration_descriptor = duplicate_at_least(verifier_output_directory_descriptor, 10);
    if (enumeration_descriptor < 0) return errno;
    DIR *directory = fdopendir(enumeration_descriptor);
    if (directory == NULL) {
        int status = errno;
        close(enumeration_descriptor);
        return status;
    }
    int visible_entries = 0;
    bool only_application = true;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (entry == NULL) break;
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        visible_entries += 1;
        if (strcmp(entry->d_name, "Recordings.app") != 0) only_application = false;
    }
    int status = errno;
    closedir(directory);
    if (status != 0) return status;
    if (visible_entries != 1 || !only_application) return EPERM;
    struct copy_budget budget = {0, 0};
    status = copy_directory_at(
        verifier_output_directory_descriptor,
        root_candidate_directory_descriptor,
        "Recordings.app",
        verifier_user_id,
        &budget
    );
    if (status == 0 &&
        !recordings_descriptor_has_no_extended_acl(root_candidate_directory_descriptor)) {
        status = EPERM;
    }
    if (status == 0 && fsync(root_candidate_directory_descriptor) != 0) {
        status = errno != 0 ? errno : EIO;
    }
    return status;
}

static int remove_tree_at(
    int parent_descriptor,
    const char *name,
    unsigned int depth,
    uint64_t *entry_budget
) {
    if (depth > 128 || *entry_budget >= 200000) return EFBIG;
    *entry_budget += 1;
    struct stat named;
    if (fstatat(parent_descriptor, name, &named, AT_SYMLINK_NOFOLLOW) != 0) {
        return errno;
    }
    if (!S_ISDIR(named.st_mode)) {
        return unlinkat(parent_descriptor, name, 0) == 0 ? 0 : errno;
    }
    int directory = openat(
        parent_descriptor,
        name,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
    );
    if (directory < 0) return errno;
    struct stat opened;
    if (fstat(directory, &opened) != 0 || named.st_dev != opened.st_dev ||
        named.st_ino != opened.st_ino ||
        !recordings_descriptor_has_no_extended_acl(directory)) {
        close(directory);
        return EBUSY;
    }
    int enumeration_descriptor = duplicate_at_least(directory, 10);
    DIR *entries = enumeration_descriptor < 0 ? NULL : fdopendir(enumeration_descriptor);
    int status = entries == NULL ? (errno != 0 ? errno : EIO) : 0;
    if (entries == NULL && enumeration_descriptor >= 0) close(enumeration_descriptor);
    while (status == 0) {
        errno = 0;
        struct dirent *entry = readdir(entries);
        if (entry == NULL) {
            if (errno != 0) status = errno;
            break;
        }
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (entry->d_name[0] == '\0' || strchr(entry->d_name, '/') != NULL) {
            status = EPERM;
            break;
        }
        status = remove_tree_at(directory, entry->d_name, depth + 1, entry_budget);
    }
    if (entries != NULL) closedir(entries);
    if (status == 0 && !recordings_descriptor_has_no_extended_acl(directory)) status = EPERM;
    if (status == 0 && fsync(directory) != 0) status = errno != 0 ? errno : EIO;
    close(directory);
    if (status == 0 && unlinkat(parent_descriptor, name, AT_REMOVEDIR) != 0) status = errno;
    if (status == 0 && fsync(parent_descriptor) != 0) status = errno != 0 ? errno : EIO;
    return status;
}

int recordings_remove_directory_tree_at(
    int root_directory_descriptor,
    const char *directory_name
) {
    if (root_directory_descriptor < 0 || !is_valid_transaction_name(directory_name)) {
        return EINVAL;
    }
    struct stat root;
    if (fstat(root_directory_descriptor, &root) != 0 || !S_ISDIR(root.st_mode) ||
        root.st_uid != 0 || (root.st_mode & 0077) != 0 ||
        !recordings_descriptor_has_no_extended_acl(root_directory_descriptor)) {
        return EPERM;
    }
    uint64_t entry_budget = 0;
    return remove_tree_at(root_directory_descriptor, directory_name, 0, &entry_budget);
}
