// Visible Credits / Open Source entry for the private-lobby build.
//
// AGPL v3 §7(b) requires the "© OpenFront and Contributors" notice to stay
// in a reasonably visible location, and Prompt 1 requires attribution plus
// a link to the corresponding source to be reachable — not buried in a
// legal page. This modal is opened from the private-lobby menu and the
// site footer.
//
// The deployment's own fork URL belongs in en.json credits.our_source_url;
// until it is set, the upstream repository stands in so the link is never
// dead.

import { html } from "lit";
import { customElement } from "lit/decorators.js";
import { translateText } from "./Utils";
import { BaseModal } from "./components/BaseModal";
import { modalHeader } from "./components/ui/ModalHeader";

@customElement("credits-modal")
export class CreditsModal extends BaseModal {
  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("credits.title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected renderBody() {
    const sourceUrl = translateText("credits.our_source_url");
    return html`
      <div class="p-6 space-y-4 text-white/80 text-sm leading-relaxed">
        <p>${translateText("credits.derived_from")}</p>
        <p>
          <a
            href="https://github.com/openfrontio/OpenFrontIO"
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-400 hover:text-blue-300 underline"
            >OpenFrontIO (upstream)</a
          >
        </p>
        <p>${translateText("credits.source_note")}</p>
        <p>
          <a
            href=${sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-400 hover:text-blue-300 underline break-all"
            >${sourceUrl}</a
          >
        </p>
        <p>${translateText("credits.assets_note")}</p>
        <p>${translateText("credits.map_data_note")}</p>
      </div>
    `;
  }
}
