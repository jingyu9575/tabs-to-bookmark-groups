import { M } from "../util/webext/i18n.js";

const subtitle = document.body.dataset.subtitle as keyof I18nMessages
document.title = subtitle ? `${M[subtitle]} - ${M.extensionName}` : M.extensionName
