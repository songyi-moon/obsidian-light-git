import { App, Modal, Setting } from "obsidian";

/** 메시지를 비우고 Enter → 기본 메시지, 입력하면 그 메시지로 커밋 */
export class CommitMessageModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private defaultMessage: string,
		private numFiles: number,
		private onSubmit: (message: string) => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle(`커밋 & 동기화 (변경 ${this.numFiles}개)`);
		const input = contentEl.createEl("input", { type: "text", cls: "light-git-commit-input", attr: { placeholder: this.defaultMessage } });
		input.addEventListener("input", () => (this.value = input.value));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});
		contentEl.createDiv({ cls: "setting-item-description", text: "비워두면 기본 메시지로 커밋합니다." });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("커밋 & 동기화").setCta().onClick(() => this.submit()));
		window.setTimeout(() => input.focus(), 50);
	}

	private submit() {
		const msg = this.value.trim() || this.defaultMessage;
		this.close();
		this.onSubmit(msg);
	}

	onClose() {
		this.contentEl.empty();
	}
}
