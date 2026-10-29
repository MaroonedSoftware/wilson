#!/bin/sh
# Stands in for `ssh` in SshHost's tests: drops every option and the target, then runs the remote
# command with this machine's `sh`, the way the host's shell would run it. Exercises SshHost's
# quoting and shell scripts end to end without a second machine.
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec sh -c "$1"
