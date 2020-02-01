import './init.js'
import { registerRemoteHandler } from "../util/webext/remote.js";
import { GroupManager } from "./group-manager.js";

const groupManager = new GroupManager()

function logError<T>(promise: Promise<T>) {
	promise.catch(console.error)
	return promise
}

export class BackgroundRemote {
	listGroups(windowId: number) { return groupManager.listGroups(windowId) }
	createGroup(name: string) { return groupManager.createGroup(name) }

	switchGroup(windowId: number, groupId?: string, unsavedGroupName?: string) {
		return logError(groupManager.switchGroup(
			windowId, groupId, unsavedGroupName))
	}
	deleteGroup(groupId: string) {
		return logError(groupManager.deleteGroup(groupId))
	}
}
registerRemoteHandler(new BackgroundRemote)
