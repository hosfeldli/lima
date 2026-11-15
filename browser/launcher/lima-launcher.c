// Lima Browser launcher: Contents/MacOS/lima (CFBundleExecutable).
//
// Gecko compiles its application identity into the binary, so a repacked
// Zen build would otherwise share Zen's profile. This launcher re-execs the
// real binary with `-app Resources/browser/application.ini`, giving Lima its
// own name, profile and remoting identity. Restarts go back through here
// because NSBundle reports this file as the main executable.
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
    char self[PATH_MAX], resolved[PATH_MAX];
    uint32_t size = sizeof(self);
    if (_NSGetExecutablePath(self, &size) != 0 || realpath(self, resolved) == NULL) {
        fprintf(stderr, "lima: cannot resolve executable path\n");
        return 1;
    }
    char macos[PATH_MAX];
    strlcpy(macos, dirname(resolved), sizeof(macos));

    char engine[PATH_MAX], ini[PATH_MAX];
    snprintf(engine, sizeof(engine), "%s/zen", macos);
    snprintf(ini, sizeof(ini), "%s/../Resources/browser/application.ini", macos);

    char **args = calloc((size_t)argc + 3, sizeof(char *));
    if (!args) return 1;
    int n = 0;
    args[n++] = engine;
    // Honor an explicit -app from the caller instead of stacking two.
    int callerSetApp = argc > 1 && strcmp(argv[1], "-app") == 0;
    if (!callerSetApp) {
        args[n++] = "-app";
        args[n++] = ini;
    }
    for (int i = 1; i < argc; i++) args[n++] = argv[i];
    args[n] = NULL;

    execv(engine, args);
    perror("lima: exec engine");
    return 1;
}
