# HarperDB Edgio Runner

A [HarperDB Component](https://docs.harperdb.io/docs/developers/components) for processing requests with Edgio.

## Usage

1. Add the extension to your HarperDB project using your package manager:

```sh
npm install git+ssh://git@github.com:tristanlee85/harperdb-edgio-runner.git --save
# or
yarn add git+ssh://git@github.com:tristanlee85/harperdb-edgio-runner.git
# or
pnpm add git+ssh://git@github.com:tristanlee85/harperdb-edgio-runner.git
```

2. Add to `config.yaml`:

```yaml
'edgio-runner':
  package: 'edgio-runner'
  files: /*
```

3. Run your app with HarperDB:

```sh
harperdb run .
```

### Extension Options

- `edgioDir`: The path to the `.edgio` directory.

## Building

This extension is built using [`Bun`](https://bun.sh). To get started, install Bun globally:

```sh
npm install -g bun
```

Then, run the following command to build the extension:

```sh
bun run build
```

This will create a `dist` directory with the built extension bundled for Node.js.

If you are developing, you can use the `watch` script to automatically rebuild the extension when you make changes to the source code.

```sh
bun run watch
```
