#ifndef RECORDINGS_VERIFIER_LAUNCHER_H
#define RECORDINGS_VERIFIER_LAUNCHER_H

#include <sys/types.h>

int recordings_descriptor_has_no_extended_acl(int descriptor);

int recordings_lookup_verifier_account(
    const char *account_name,
    uid_t *user_id,
    gid_t *group_id
);

int recordings_run_artifact_verifier(
    int archive_descriptor,
    int output_directory_descriptor,
    uid_t verifier_user_id,
    gid_t verifier_group_id,
    const char *expected_archive_sha256
);

int recordings_copy_canonical_application_tree(
    int verifier_output_directory_descriptor,
    int root_candidate_directory_descriptor,
    uid_t verifier_user_id
);

int recordings_remove_directory_tree_at(
    int root_directory_descriptor,
    const char *directory_name
);

#endif
