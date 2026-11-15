#include "lima_pty.h"
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>
#include <util.h>

int lima_pty_spawn(const char *path, char *const argv[], char *const envp[], const char *cwd,
                   unsigned short cols, unsigned short rows, int *master_out, pid_t *pid_out) {
    struct winsize ws = { .ws_row = rows, .ws_col = cols, .ws_xpixel = 0, .ws_ypixel = 0 };
    int master = -1;
    pid_t pid = forkpty(&master, NULL, NULL, &ws);
    if (pid < 0) return errno;
    if (pid == 0) {
        sigset_t empty;
        sigemptyset(&empty);
        sigprocmask(SIG_SETMASK, &empty, NULL);
        for (int sig = 1; sig < NSIG; sig++) signal(sig, SIG_DFL);
        int maxfd = (int)sysconf(_SC_OPEN_MAX);
        for (int fd = 3; fd < maxfd && fd < 4096; fd++) close(fd);
        if (cwd && chdir(cwd) != 0) chdir("/");
        execve(path, argv, envp);
        _exit(127);
    }
    fcntl(master, F_SETFD, FD_CLOEXEC);
    int flags = fcntl(master, F_GETFL);
    fcntl(master, F_SETFL, flags | O_NONBLOCK);
    *master_out = master;
    *pid_out = pid;
    return 0;
}

int lima_pty_resize(int master, unsigned short cols, unsigned short rows) {
    struct winsize ws = { .ws_row = rows, .ws_col = cols, .ws_xpixel = 0, .ws_ypixel = 0 };
    return ioctl(master, TIOCSWINSZ, &ws) == 0 ? 0 : errno;
}

pid_t lima_pty_foreground(int master) {
    return tcgetpgrp(master);
}
