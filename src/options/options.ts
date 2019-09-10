import "../common/elements/x-tab.js"
import { applyI18n } from "../util/webext/i18n.js";
import { remoteSettings, Settings } from "../common/settings.js";

applyI18n()

type InputCallback = (input: HTMLInputElement | HTMLSelectElement) => unknown
const inputCallbacks = new Map<keyof Settings, InputCallback>([
])

for (const input of document.querySelectorAll(
	'[data-key]') as NodeListOf<HTMLInputElement | HTMLSelectElement>) {
	const key = input.dataset.key!
	remoteSettings.get(key as any).then(value => {
		if (input.type === 'checkbox')
			(input as HTMLInputElement).checked = value
		else
			input.value = '' + value
		void (inputCallbacks.get(key as keyof Settings) || (_ => 0))(input)
	})
	input.addEventListener('change', () => {
		if (!input.checkValidity()) return
		let value: any
		if (input.type === 'number') {
			value = (!input.required && !input.value) ? '' : Number(input.value)
		} else if (input.type === 'checkbox')
			value = (input as HTMLInputElement).checked
		else value = input.value
		void remoteSettings.set({ [key]: value })
		void (inputCallbacks.get(key as keyof Settings) || (_ => 0))(input)
	})
}