# Private Repository Management

Clinic has two main repos, a private and a public one.
At some point, once everything is stable and features like
bubbleprof has been released the idea is to only have a public.

For now the private repo allows to experiment and iterate faster.

Until `bubbleprof` has been released, for this to work with a minimal amount
of merge conficts, it is important that `doctor` and `bubbleprof` code is
isolated, and their respective commits are seperated.

# Backporting commits from the private to public repo 

To copy a commit from the private `node-clinic-private` repo to the public
`node-clinic` repo, first clone the public repo and setup the priate repo as
a remote.

```
git clone git@github.com:nearform/node-clinic.git node-clinic-public
cd node-clinic-public
git remote add clinic-private git@github.com:nearform/node-clinic-private.git
```

Then to copy a specific commit use:

```
git fetch clinic-private
git cherry-pick COMMIT_HASH
```

# Moving commits from the public to the private repo

In case PRs land on the public repo we need to migrate them to the private
one as well to ease development and future backports. The process is the
same as with backporting from the private to the public, only reversed.

```
git clone git@github.com:nearform/node-clinic-private.git
cd node-clinic-private
git remote add clinic-public git@github.com:nearform/node-clinic.git
```

Then to copy a specific commit use:

```
git fetch clinic-public
git cherry-pick COMMIT_HASH
```
