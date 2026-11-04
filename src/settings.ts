import { App, PluginSettingTab, Setting } from "obsidian";
import type LightGitPlugin from "./main";

export type BackendChoice = "auto" | "native" | "isomorphic";

export interface LightGitSettings {
	remoteUrl: string;
	/** git 저장소로 쓸 vault 하위 폴더 (빈 값 = vault 전체) */
	repoFolder: string;
	branch: string;
	username: string;
	authorName: string;
	authorEmail: string;
	deviceName: string;
	commitTemplate: string;
	askMessageOnManualSync: boolean;
	autoSyncMinutes: number;
	pullOnStartup: boolean;
	backend: BackendChoice;
	chunkMB: number;
}

export const DEFAULT_SETTINGS: LightGitSettings = {
	remoteUrl: "",
	repoFolder: "",
	branch: "main",
	username: "",
	authorName: "",
	authorEmail: "",
	deviceName: "",
	commitTemplate: "vault backup: {{date}} ({{device}})",
	askMessageOnManualSync: true,
	autoSyncMinutes: 0,
	pullOnStartup: true,
	backend: "auto",
	chunkMB: 20,
};

export class LightGitSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: LightGitPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		const s = p.settings;
		const save = () => p.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("원격 저장소").setHeading();
		new Setting(containerEl)
			.setName("저장소 URL")
			.setDesc("HTTPS 주소 (예: https://github.com/me/vault.git). 데스크톱 네이티브 git은 SSH 주소도 가능.")
			.addText((t) => t.setPlaceholder("https://...").setValue(s.remoteUrl).onChange(async (v) => ((s.remoteUrl = v.trim()), await save())));
		new Setting(containerEl)
			.setName("저장소 폴더")
			.setDesc("vault 안의 이 폴더만 git 저장소로 씁니다 (예: notes). 비우면 vault 전체. 기기마다 다른 .obsidian 설정을 git에서 빼려면 지정하세요. 없으면 만들고, 연결하면 원격을 이 폴더로 받아옵니다.")
			.addText((t) =>
				t.setPlaceholder("(vault 전체)").setValue(s.repoFolder).onChange(async (v) => {
					s.repoFolder = v.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
					await save();
					p.resetBackend();
				}),
			);
		new Setting(containerEl).setName("브랜치").addText((t) => t.setValue(s.branch).onChange(async (v) => ((s.branch = v.trim() || "main"), await save())));
		new Setting(containerEl)
			.setName("사용자명")
			.setDesc("GitHub는 아무 값이나 가능, GitLab/Gitea는 계정명.")
			.addText((t) => t.setValue(s.username).onChange(async (v) => ((s.username = v.trim()), await save())));
		new Setting(containerEl)
			.setName("토큰 / 비밀번호")
			.setDesc("Personal Access Token. 이 기기에만 저장되며 vault(=git)에 들어가지 않습니다.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(p.getToken()).onChange((v) => p.setToken(v.trim()));
			});
		new Setting(containerEl)
			.setName("연결")
			.setDesc("저장소가 없으면 만들고, 원격에 내용이 있으면 받아옵니다. (기존 vault를 처음 올릴 때도 사용) 연결 테스트는 파일을 건드리지 않고 URL과 읽기 권한만 확인합니다.")
			.addButton((b) => b.setButtonText("연결 테스트").onClick(() => p.testConnection()))
			.addButton((b) => b.setButtonText("원격 저장소 연결").setCta().onClick(() => p.connect()));

		new Setting(containerEl).setName("커밋").setHeading();
		new Setting(containerEl)
			.setName("기본 커밋 메시지")
			.setDesc("메시지를 비워두면 이 값이 쓰입니다. {{date}}, {{device}}, {{numFiles}} 사용 가능.")
			.addText((t) => t.setValue(s.commitTemplate).onChange(async (v) => ((s.commitTemplate = v || DEFAULT_SETTINGS.commitTemplate), await save())));
		new Setting(containerEl)
			.setName("수동 동기화 시 메시지 입력창 띄우기")
			.setDesc("끄면 항상 기본 메시지로 바로 동기화합니다. 자동 동기화는 항상 기본 메시지.")
			.addToggle((t) => t.setValue(s.askMessageOnManualSync).onChange(async (v) => ((s.askMessageOnManualSync = v), await save())));
		new Setting(containerEl).setName("작성자 이름").addText((t) => t.setValue(s.authorName).onChange(async (v) => ((s.authorName = v), await save())));
		new Setting(containerEl).setName("작성자 이메일").addText((t) => t.setValue(s.authorEmail).onChange(async (v) => ((s.authorEmail = v), await save())));
		new Setting(containerEl)
			.setName("기기 이름")
			.setDesc("{{device}}에 들어갈 값. 비우면 desktop/mobile.")
			.addText((t) => t.setValue(s.deviceName).onChange(async (v) => ((s.deviceName = v), await save())));

		new Setting(containerEl).setName("자동화").setHeading();
		new Setting(containerEl)
			.setName("자동 동기화 간격 (분)")
			.setDesc("0이면 끔.")
			.addText((t) =>
				t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
					s.autoSyncMinutes = Math.max(0, Number(v) || 0);
					await save();
					p.scheduleAutoSync();
				}),
			);
		new Setting(containerEl).setName("앱 시작 시 pull").addToggle((t) => t.setValue(s.pullOnStartup).onChange(async (v) => ((s.pullOnStartup = v), await save())));

		new Setting(containerEl).setName("고급").setHeading();
		new Setting(containerEl)
			.setName("Git 엔진")
			.setDesc(`자동: 데스크톱은 설치된 git, 모바일은 내장 엔진. 현재: ${p.backendName()}`)
			.addDropdown((d) =>
				d
					.addOptions({ auto: "자동", native: "설치된 git (데스크톱)", isomorphic: "내장 엔진 (isomorphic-git)" })
					.setValue(s.backend)
					.onChange(async (v) => {
						s.backend = v as BackendChoice;
						await save();
						p.resetBackend();
						this.display();
					}),
			);
		new Setting(containerEl)
			.setName("분할 크기 (MB)")
			.setDesc("내장 엔진이 한 번에 커밋/전송하는 최대 크기. iOS에서 앱이 꺼지면 낮추세요.")
			.addText((t) => t.setValue(String(s.chunkMB)).onChange(async (v) => ((s.chunkMB = Math.max(1, Number(v) || DEFAULT_SETTINGS.chunkMB)), await save())));
	}
}
