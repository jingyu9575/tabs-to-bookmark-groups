import './init.js'
import { registerRemoteHandler } from "../util/webext/remote.js";
import { GroupManager } from "./group-manager.js";

registerRemoteHandler(new GroupManager)

export class BackgroundRemote { }
registerRemoteHandler(new BackgroundRemote)

void navigator.storage.persist()