/* Loaded into every content process so about:lima resolves there too. */
try {
  ChromeUtils.importESModule("resource://lima/LimaAbout.sys.mjs").registerAboutLima();
} catch (error) {
  dump(`[lima] content-process about:lima registration failed: ${error}\n`);
}
