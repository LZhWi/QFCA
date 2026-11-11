// Run before loading ws: the audited offline closure excludes native peers.
// Never resolve optional native addons from an ancestor installation.
process.env.WS_NO_BUFFER_UTIL = "1";
process.env.WS_NO_UTF_8_VALIDATE = "1";
