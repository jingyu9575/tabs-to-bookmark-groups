import { registerRemoteHandler } from "../util/webext/remote.js";

export class BackgroundRemote {
}
registerRemoteHandler(new BackgroundRemote)
