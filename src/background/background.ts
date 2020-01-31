import { registerRemoteHandler } from "../util/webext/remote.js";
import { GroupManager } from "./group-manager.js";

const groupManager = new GroupManager()

export class BackgroundRemote {
	listGroups(windowId: number) { return groupManager.listGroups(windowId) }
	createGroup(name: string) { return groupManager.createGroup(name) }

	switchGroup(windowId: number, groupId?: string, unsavedGroupName?: string) {
		const promise = groupManager.switchGroup(windowId, groupId, unsavedGroupName)
		promise.catch(console.error)
		return promise
	}
}
registerRemoteHandler(new BackgroundRemote)

browser.runtime.onInstalled.addListener(({ reason, temporary }) => {
	if (reason === 'install' && !temporary)
		browser.tabs.create({ url: '/pages/first-install.html' });
})