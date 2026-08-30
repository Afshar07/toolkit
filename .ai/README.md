# Toolkit context

Toolkit is a personal CLI for recreating a development workspace on another machine.

The workspace parent is often not a Git repository; its child directories are independent repositories. Recreating that layout manually is repetitive and error-prone.

Toolkit captures the reconstruction recipe instead of copying a machine: repository remotes, portable relative paths, lightweight Node/package-manager hints, and selected empty directories. `scan` produces the recipe; `setup` recreates it safely without overwriting existing work or installing dependencies.
