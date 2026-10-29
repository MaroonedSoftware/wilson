#!/bin/sh
# Stands in for `ssh` in the host tests: drops every option and the target, then runs the remote
# command with this machine's `sh`, the way the host's shell would run it. Exercises SshHost's
# quoting and shell scripts, and git's own push and fetch to a host, end to end without a second
# machine.
#
# SshHost passes the command after `--`. git passes it as the last argument, with no `--`.
for arg in "$@"; do last=$arg; done
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
if [ "$#" -gt 0 ]; then
    shift
    exec sh -c "$1"
fi
exec sh -c "$last"
