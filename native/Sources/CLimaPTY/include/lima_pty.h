#ifndef LIMA_PTY_H
#define LIMA_PTY_H
#include <sys/types.h>

/// Spawns `path` on a new pseudo-terminal as a session leader with the PTY as
/// its controlling terminal. All child-side work happens in C between fork and
/// exec, so no Swift runtime code runs in the forked child.
/// Returns 0 on success, otherwise errno.
int lima_pty_spawn(const char *path, char *const argv[], char *const envp[], const char *cwd,
                   unsigned short cols, unsigned short rows, int *master_out, pid_t *pid_out);

int lima_pty_resize(int master, unsigned short cols, unsigned short rows);

/// Foreground process group of the terminal, or -1.
pid_t lima_pty_foreground(int master);

#endif
