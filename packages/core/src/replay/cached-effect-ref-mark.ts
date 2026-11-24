// The error data field that marks an effectRef the gateway restored from its key binding, rather
// than one the daemon's own error held. The gateway sets it, and the /rpc route reads it and
// drops both the mark and the restored effectRef.
export const CACHED_EFFECT_REF_MARK = 'effectRefIsCached';
