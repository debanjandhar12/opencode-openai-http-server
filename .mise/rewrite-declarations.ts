const glob = new Bun.Glob('**/*.d.ts');

for await (const path of glob.scan({ cwd: 'dist', absolute: true })) {
  const source = await Bun.file(path).text();
  const rewritten = source.replace(
    /(from\s+['"]|import\(['"])(\.{1,2}\/[^'"]+)\.ts(['"]\)?)/g,
    '$1$2.js$3'
  );
  if (rewritten !== source) await Bun.write(path, rewritten);
}
