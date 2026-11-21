#include "lima_pty.h"
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <libproc.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>
#include <util.h>
#include <sys/wait.h>
#include <poll.h>

int lima_pty_spawn(const char *path, char *const argv[], char *const envp[], const char *cwd,
                   unsigned short cols, unsigned short rows, int *master_out, pid_t *pid_out) {
    int startup[2];
    if (pipe(startup) != 0) return errno;
    if (fcntl(startup[1], F_SETFD, FD_CLOEXEC) != 0) {
        int error = errno;
        close(startup[0]);
        close(startup[1]);
        return error;
    }

    struct winsize ws = { .ws_row = rows, .ws_col = cols, .ws_xpixel = 0, .ws_ypixel = 0 };
    int master = -1;
    pid_t pid = forkpty(&master, NULL, NULL, &ws);
    if (pid < 0) {
        int error = errno;
        close(startup[0]);
        close(startup[1]);
        return error;
    }
    if (pid == 0) {
        close(startup[0]);
        sigset_t empty;
        sigemptyset(&empty);
        sigprocmask(SIG_SETMASK, &empty, NULL);
        for (int sig = 1; sig < NSIG; sig++) signal(sig, SIG_DFL);
        int maxfd = (int)sysconf(_SC_OPEN_MAX);
        for (int fd = 3; fd < maxfd && fd < 4096; fd++) {
            if (fd != startup[1]) close(fd);
        }
        if (!cwd || chdir(cwd) == 0) execve(path, argv, envp);
        int error = errno;
        ssize_t written;
        do { written = write(startup[1], &error, sizeof(error)); } while (written < 0 && errno == EINTR);
        _exit(127);
    }
    close(startup[1]);
    struct pollfd confirmation = { .fd = startup[0], .events = POLLIN };
    int ready;
    do { ready = poll(&confirmation, 1, 8000); } while (ready < 0 && errno == EINTR);
    int startup_error = ready == 0 ? ETIMEDOUT : ready < 0 ? errno : 0;
    if (ready > 0) {
        int child_error = 0;
        ssize_t result;
        do { result = read(startup[0], &child_error, sizeof(child_error)); } while (result < 0 && errno == EINTR);
        startup_error = result < 0 ? errno : result == 0 ? 0 : child_error;
    }
    close(startup[0]);
    if (startup_error != 0) {
        close(master);
        if (ready <= 0) kill(pid, SIGKILL);
        while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) {}
        return startup_error;
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


int lima_pty_cwd(pid_t pid, char *buffer, size_t capacity) {
    struct proc_vnodepathinfo info;
    if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
    size_t length = strnlen(info.pvi_cdir.vip_path, sizeof(info.pvi_cdir.vip_path));
    if (length == 0 || length >= capacity) return 0;
    memcpy(buffer, info.pvi_cdir.vip_path, length);
    buffer[length] = 0;
    return 1;
}
