# M14 browser agent check

On device A, run the scripted browser task on the test page. The live view shows each step. Stop ends the session within 2 seconds. The first visit to a site waits on Approvals. A later visit to the same site does not.

With remote debugging blocked, the agent uses rung 5 and explains that rungs 0 and 1 were skipped because of `RemoteDebuggingAllowed`. The stop, the first-visit approval, and the rung drop run in CI. The live task on device A is this check.
