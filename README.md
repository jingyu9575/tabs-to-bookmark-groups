# Tabs to Bookmark Groups

(Work in progress) Firefox extension to save the tabs to a bookmark group and switch between different groups.

## Build

Install the dependencies:

```sh
npm install --only=prod
```

The globally installed build tools can be used, found by `$PATH`. It is also possible to install the packages locally:

```sh
npm install --only=dev
```

Run the build script to generate the unpacked extension in `dist`:

```sh
node build
```

Create unsigned XPI release: (requires the `zip` command)

```sh
node build --xpi
```
