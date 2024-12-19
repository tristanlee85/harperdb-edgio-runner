# HarperDB EdgeControl Parser

A [HarperDB Component](https://docs.harperdb.io/docs/developers/components) for parsing EdgeControl rules.

## Usage

> [!NOTE]
> This guide assumes you're already familiar with [HarperDb Components](https://docs.harperdb.io/docs/developers/components). Check out [`harperdb-proxy-transform-example`](https://github.com/tristanlee85/harperdb-proxy-transform-example) for more information.

1. Add the extension to your HarperDB project using your package manager:

```sh
npm install git+ssh://git@github.com:tristanlee85/edge-control-parser.git --save
# or
yarn add git+ssh://git@github.com:tristanlee85/edge-control-parser.git
# or
pnpm add git+ssh://git@github.com:tristanlee85/edge-control-parser.git
```

2. Add to `config.yaml`:

```yaml
'edge-control-parser':
  package: 'edge-control-parser'
  files: /*
  edgeControlPath: /path/to/edge-control.json
```

3. Run your app with HarperDB:

```sh
harperdb run .
```

### Extension Options

- `edgeControlPath`: The path to the EdgeControl file.

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
