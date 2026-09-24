# Domain package

Owns Task, Task Revision, mandate, Harness Revision, Run, evolution,
evaluation, checkpoint, publication, and Registration Session state laws. It
contains no framework, database, HTTP, CLI, model, or KERI adapter code.

A Task is durable intent; a Run is one governed attempt; a Run Incarnation is
live XState realization; a Pi Agent Session is subordinate runtime state. The
domain package owns lawful Run transitions. The Run Supervisor applies them
but does not redefine them.
