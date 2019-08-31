import { applyI18n, applyI18nAttr, M } from "../util/webext/i18n.js";
import { importTemplate, defineBooleanAttribute, defineStringAttribute } from "../util/dom.js";
import { backgroundRemote } from "../common/common.js";
import { GroupState } from "../common/types.js";

applyI18n()
applyI18nAttr('title')

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

		this.buttonNode.addEventListener('click', () => {
			if (windowId === undefined || this.groupId === undefined) return
			backgroundRemote.switchGroup(windowId, this.groupId)
			location.reload()
		})

		return this
	}

	static create() {
		return this.parent.appendChild(new this().init())
	}

	static readonly observedAttributes = ['state', 'name'] as const
	attributeChangedCallback(name: typeof XGroupElement.observedAttributes[number],
		_oldValue: string | null, newValue: string | null) {
		if (name === 'state') {
			this.buttonNode.disabled = newValue !== 'closed'
		} else if (name === 'name') {
			this.nameNode.textContent = newValue || ''
		}
	}
}
defineStringAttribute(XGroupElement, 'state')
defineStringAttribute(XGroupElement, 'name')
customElements.define('x-group', XGroupElement)

browser.windows.getCurrent().then(async (currentWindow) => {
	windowId = currentWindow.id!

	const groups = await backgroundRemote.listGroups(windowId)
	for (const group of groups) {
		const node = XGroupElement.create()
		node.groupId = group.id
		node.name = group.name
		node.state = group.state
	}

	document.getElementById('create')!.addEventListener('click', async () => {
		const name = prompt(M.groupName, M.unnamed)
		if (name == null) return
		await backgroundRemote.createGroup(name)
		location.reload()
	})
})
