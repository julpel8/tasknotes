import { Notice, type Setting } from "obsidian";
import type TaskNotesPlugin from "../../main";
import type { TranslationKey } from "../../i18n";
import { CALDAV_PASSWORD_SECRET_ID } from "../../services/caldav/CalDAVCalendarService";
import {
	createSettingGroup,
	configureDropdownSetting,
	configureTextSetting,
	configureToggleSetting,
	configureNumberSetting,
	configureButtonSetting,
	runAsyncSettingCallback,
} from "../components/settingHelpers";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

function configurePasswordSetting(setting: Setting, plugin: TaskNotesPlugin, translate: Translate) {
	setting
		.setName(translate("settings.integrations.caldav.password.name"))
		.setDesc(translate("settings.integrations.caldav.password.description"))
		.addText((text) => {
			text.inputEl.type = "password";
			text.inputEl.autocomplete = "off";
			const stored = plugin.app.secretStorage?.getSecret(CALDAV_PASSWORD_SECRET_ID);
			text.setPlaceholder(
				stored
					? translate("settings.integrations.caldav.password.saved")
					: translate("settings.integrations.caldav.password.placeholder")
			);
			text.onChange((value) => {
				plugin.app.secretStorage?.setSecret(CALDAV_PASSWORD_SECRET_ID, value);
			});
		});
}

/**
 * CalDAV section of the integrations tab: server, account, password (kept in
 * SecretStorage) and the calendars to show.
 */
export function renderCalDAVSettings(
	container: HTMLElement,
	plugin: TaskNotesPlugin,
	save: () => void,
	translate: Translate,
	rerender: () => void
): void {
	const settings = plugin.settings.caldav;
	const service = plugin.caldavCalendarService;

	createSettingGroup(
		container,
		{
			heading: translate("settings.integrations.caldav.header"),
			description: translate("settings.integrations.caldav.description"),
		},
		(group) => {
			group.addSetting((setting) =>
				void configureToggleSetting(setting, {
					name: translate("settings.integrations.caldav.enable.name"),
					desc: translate("settings.integrations.caldav.enable.description"),
					getValue: () => settings.enabled,
					setValue: async (value: boolean) => {
						settings.enabled = value;
						save();
						if (value) {
							await service?.initialize();
						} else {
							service?.destroy();
							plugin.notifyDataChanged(undefined, false, true);
						}
						rerender();
					},
				})
			);

			if (!settings.enabled) return;

			group.addSetting((setting) =>
				void configureTextSetting(setting, {
					name: translate("settings.integrations.caldav.serverUrl.name"),
					desc: translate("settings.integrations.caldav.serverUrl.description"),
					placeholder: "https://example.com/dav.php/",
					getValue: () => settings.serverUrl,
					setValue: (value: string) => {
						settings.serverUrl = value.trim();
						save();
					},
				})
			);

			group.addSetting((setting) =>
				void configureTextSetting(setting, {
					name: translate("settings.integrations.caldav.username.name"),
					desc: translate("settings.integrations.caldav.username.description"),
					getValue: () => settings.username,
					setValue: (value: string) => {
						settings.username = value.trim();
						save();
					},
				})
			);

			group.addSetting((setting) => void configurePasswordSetting(setting, plugin, translate));

			group.addSetting((setting) =>
				void configureButtonSetting(setting, {
					name: translate("settings.integrations.caldav.connect.name"),
					desc: translate("settings.integrations.caldav.connect.description"),
					buttonText: translate("settings.integrations.caldav.connect.button"),
					onClick: () =>
						runAsyncSettingCallback(async () => {
							try {
								const calendars = await service.listCalendars();
								new Notice(
									translate("settings.integrations.caldav.connect.success", {
										count: calendars.length,
									})
								);
								await service.initialize();
							} catch (error) {
								new Notice(
									translate("settings.integrations.caldav.connect.failure", {
										error: error instanceof Error ? error.message : String(error),
									})
								);
							}
							rerender();
						}),
				})
			);

			for (const calendar of settings.calendars) {
				if (!calendar.components.includes("VEVENT")) continue;
				group.addSetting((setting) =>
					void configureToggleSetting(setting, {
						name: calendar.name,
						desc: translate("settings.integrations.caldav.calendarToggle.description"),
						getValue: () => calendar.enabled,
						setValue: async (value: boolean) => {
							calendar.enabled = value;
							save();
							await service.refresh();
							plugin.notifyDataChanged(undefined, false, true);
						},
					})
				);
			}

			const taskCalendars = settings.calendars.filter((calendar) =>
				calendar.components.includes("VTODO")
			);
			group.addSetting((setting) =>
				void configureToggleSetting(setting, {
					name: translate("settings.integrations.caldav.syncTasks.name"),
					desc: translate("settings.integrations.caldav.syncTasks.description"),
					getValue: () => settings.syncTasks,
					setValue: (value: boolean) => {
						settings.syncTasks = value;
						save();
						if (value) void plugin.caldavTaskSyncService?.runPass(true);
						rerender();
					},
				})
			);

			if (settings.syncTasks) {
				group.addSetting((setting) =>
					void configureDropdownSetting(setting, {
						name: translate("settings.integrations.caldav.taskCalendar.name"),
						desc: translate("settings.integrations.caldav.taskCalendar.description"),
						options: [
							{
								value: "",
								label: translate("settings.integrations.caldav.taskCalendar.none"),
							},
							...taskCalendars.map((calendar) => ({
								value: calendar.url,
								label: calendar.name,
							})),
						],
						getValue: () => settings.taskCalendarUrl,
						setValue: (value: string) => {
							settings.taskCalendarUrl = value;
							save();
							if (value) void plugin.caldavTaskSyncService?.runPass(true);
						},
					})
				);
			}

			group.addSetting((setting) =>
				void configureNumberSetting(setting, {
					name: translate("settings.integrations.caldav.refreshMinutes.name"),
					desc: translate("settings.integrations.caldav.refreshMinutes.description"),
					min: 1,
					max: 1440,
					getValue: () => settings.refreshMinutes,
					setValue: (value: number) => {
						settings.refreshMinutes = value;
						save();
					},
				})
			);
		}
	);
}
