import { applyI18n, applyI18nAttr, M } from "../util/webext/i18n.js";
import { importTemplate, defineStringAttribute } from "../util/dom.js";
import {
	groupManagerRemote, getWindowTabsToSave, panelGroupMenus, groupColorCodesLight, GroupColor, groupColorCodesDark
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
	static readonly tagName = 'x-group'

	private static get list() {
		return [...this.parent.getElementsByTagName(this.tagName)] as XGroupElement[]
	}

	state!: GroupState
	name!: string
	color?: string
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

			let unsavedGroupName: string | null = XGroupElement.newGroupName()
			if (this.state === 'unsaved' ||
				XGroupElement.parent.querySelector('.group[state="unsaved"]') &&
				(await getWindowTabsToSave(windowId, true)).length) {
				unsavedGroupName = prompt(M.saveCurrentWindowAs, unsavedGroupName)
				if (unsavedGroupName == null) return
			}
			void groupManagerRemote.switchGroup(
				windowId, this.groupId, unsavedGroupName)
			if (this.groupId !== undefined &&
				Number(new URL(location.href).searchParams.get('browserAction')))
				window.close()
		})

		return this
	}

	static create() {
		return this.parent.appendChild(new this().init())
	}

	static readonly groupProps = ['state', 'name', 'color'] as const
	static readonly observedAttributes = XGroupElement.groupProps
	attributeChangedCallback(name: typeof XGroupElement.observedAttributes[number],
		_oldValue: string | null, value: string | null) {
		if (name === 'name') {
			this.nameNode.textContent = value || ''
		} else if (name === 'color') {
			this.style.setProperty('--group-color-light',
				value && groupColorCodesLight.get(value as GroupColor) || 'inherit')
			this.style.setProperty('--group-color-dark',
				value && groupColorCodesDark.get(value as GroupColor) || 'inherit')
		}
	}

	menuItemStatus() {
		return {
			deleteGroup: { enabled: this.groupId !== undefined },
			setColor: { enabled: this.groupId !== undefined },
		}
	}

	static newGroupName() {
		const used = new Set(this.list.map(v => v.name))
		let result: string
		for (let i = 1; used.has((result = M('groupN', i))); i++) { }
		return result
	}

	async deleteGroup() {
		if (this.groupId === undefined) return
		if (!confirm(M.confirmDeleteGroup)) return
		await groupManagerRemote.deleteGroup(this.groupId)
	}

	async setColor([color]: string[]) {
		if (this.groupId === undefined) return
		await groupManagerRemote.setGroupColor(this.groupId,
			color !== 'none' ? color as GroupColor : undefined)
	}
}
for (const key of XGroupElement.groupProps)
	defineStringAttribute(XGroupElement, key)
customElements.define(XGroupElement.tagName, XGroupElement)

browser.windows.getCurrent().then(async (currentWindow) => {
	windowId = currentWindow.id!

	const groups = await groupManagerRemote.listGroups(windowId)
	for (const group of groups) {
		const node = XGroupElement.create()
		node.groupId = group.id
		for (const key of XGroupElement.groupProps)
			(node[key] as string) = group[key] || ''
	}

	document.getElementById('create')!.addEventListener('click', async () => {
		const name = prompt(M.groupName, XGroupElement.newGroupName())
		if (name == null) return
		await groupManagerRemote.createGroup(name)
	})
})

panelGroupMenus.listen(XGroupElement.tagName, XGroupElement.prototype,
	XGroupElement.prototype.menuItemStatus)
ExtensionPageMenus.preventDefault()
