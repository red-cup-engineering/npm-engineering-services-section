# npm package-set services section

A package set is an explicit collection of npm package directory carriers. It
does not imply dependency, workspace, registry, or ecosystem relations among
the packages.

Services here read such collections or map singular npm package services
over them. They do not reimplement singular manifest operations.

Every service package contains one executable implementation module, addressed
by both its `exports` and `bin` fields. The section directory itself is not a
registry package.
