// web-ext configuration.
//
// `web-ext build` and `web-ext sign` package the source directory directly --
// they do not use build.sh, so build.sh's exclusions do not apply to them.
// Without this list, a signed .xpi would carry the development files, including
// dev-run.log, which records claude.ai API traffic. AMO also flags the shell
// scripts. Keep this in step with the exclusions in build.sh.
module.exports = {
  ignoreFiles: [
    'build.sh',
    'dev-run.sh',
    'dev-run.log',
    'web-ext-artifacts',
    'web-ext-config.cjs',
  ],
};
