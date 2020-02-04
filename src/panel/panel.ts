import { applyI18n, applyI18nAttr, M } from "../util/webext/i18n.js";
import { importTemplate, defineStringAttribute } from "../util/dom.js";
import {
	groupManagerRemote, getWindowTabsToSave, panelGroupMenus
} from "../common/common.js";
import { GroupState } from "../common/types.js";
import { ExtensionPageMenus } from "../util/webext/menu.js";
import { registerRemoteHandler } from "../util/webext/remote.js";
import { setImmediate } from "../util/set-immediate.js";

applyI18n()
applyI18nAttr('title')

export class PanelRemote {
	async reload() { setImmediate(() => location.reload()) }
}
registerRemoteHandler(new PanelRemote)

let windowId: number | undefined

class XGroupElement extends HTMLElement {
	static readonly parent = document.getElementById('groups')! as HTMLElement

	state!: GroupState
	name!: string
	groupId?: string

	private buttonNode!: HTMLButtonElement
	private nameNode!: HTMLElement

	private constructor() { super() }

	private init() {
		this.classList.add('group')
		this.appendChild(importTemplate('x-group-template'))
		this.buttonNode = this.querySelector('.group-button') as HTMLButtonElement
		this.nameNode = this.querySelector('.group-name') as HTMLElement

		this.buttonNode.addEventListener('click', async () => {
			if (windowId === undefined) return
			if (this.state === 'locked') {
				alert(M.groupIsLocked)
				return
			}

			let unsavedGroupName: string | null = M.unnamed
			if (this.state === 'unsaved' ||
				XGroupElement.parent.querySelector('.group[state="unsaved"]') &&
				(await getWindowTabsToSave(windowId, true)).length) {
				unsavedGroupName = prompt(M.saveCurrentWindowAs, M.unnamed)
				if (unsavedGroupName == null) return
			}
			await groupManagerRemote.switchGroup(
				windowId, this.groupId, unsavedGroupName)
		})

		return this
	}

	static create() {
		return this.parent.appendChild(new this().init())
	}

	static readonly observedAttributes = ['state', 'name'] as const
	attributeChangedCallback(name: typeof XGroupElement.observedAttributes[number],
		_oldValue: string | null, newValue: string | null) {
		if (name === 'name') {
			this.nameNode.textContent = newValue || ''
		}
	}

	menuItemStatus() {
		return { deleteGroup: { enabled: this.groupId !== undefined } }
	}

	async deleteGroup() {
		if (this.groupId === undefined) return
		if (!confirm(M.confirmDeleteGroup)) return
		await groupManagerRemote.deleteGroup(this.groupId)
		location.reload()
	}
}
defineStringAttribute(XGroupElement, 'state')
defineStringAttribute(XGroupElement, 'name')
customElements.define('x-group', XGroupElement)

browser.windows.getCurrent().then(async (currentWindow) => {
	windowId = currentWindow.id!

	const groups = await groupManagerRemote.listGroups(windowId)
	for (const group of groups) {
		const node = XGroupElement.create()
		node.groupId = group.id
		node.name = group.name
		node.state = group.state
	}

	document.getElementById('create')!.addEventListener('click', async () => {
		const name = prompt(M.groupName, M.unnamed)
		if (name == null) return
		await groupManagerRemote.createGroup(name)
		location.reload()
	})
})

panelGroupMenus.listen('.group', XGroupElement.prototype,
	XGroupElement.prototype.menuItemStatus)
ExtensionPageMenus.preventDefault()
