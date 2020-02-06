import { registerRemoteHandler } from "../util/webext/remote.js";
import { groupManager } from "./group-manager.js";
import './init.js'

registerRemoteHandler(groupManager)

export class BackgroundRemote { }
registerRemoteHandler(new BackgroundRemote)

void navigator.storage.persist()