import { useCallback, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
import type { ComposerAttachment } from "@/attachments/types";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { resolvePluginIcon } from "../icons";
import type { PluginResourceComposerAttachment } from "./model";

const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function ResourceIcon({
  Icon,
  color = "",
}: {
  Icon: ReturnType<typeof resolvePluginIcon>;
  color?: string;
}) {
  return <Icon size={ICON_SIZE.sm} color={color} />;
}

const ThemedResourceIcon = withUnistyles(ResourceIcon);

import { useRetainedPanelActive } from "@/components/retained-panel";

interface PluginResourceAttachmentPillProps {
  attachment: PluginResourceComposerAttachment;
  index: number;
  disabled: boolean;
  onOpen: (attachment: ComposerAttachment) => void;
  onRemove: (index: number) => void;
  openLabel: (kind: string, identifier: string) => string;
  removeLabel: (kind: string, identifier: string) => string;
}

export function PluginResourceAttachmentPill({
  attachment,
  index,
  disabled,
  onOpen,
  onRemove,
  openLabel,
  removeLabel,
}: PluginResourceAttachmentPillProps) {
  const Icon = resolvePluginIcon(attachment.sourceIcon);
  const handleOpen = useCallback(() => onOpen(attachment), [attachment, onOpen]);
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  const icon = useMemo(
    () => <ThemedResourceIcon Icon={Icon} uniProps={iconColorMapping} />,
    [Icon],
  );
  // The composer lives inside the workspace deck, which keeps inactive
  // workspaces mounted and hides them with `display: "none"`. Without this an
  // attached plugin resource rendered a pill in the hidden screen too, and a
  // first-match query for the pill testID found that invisible one. Gated like
  // PluginHeaderButtons and PluginComposerPills. After the last hook, so hook
  // order holds.
  const active = useRetainedPanelActive();
  if (!active) return null;
  return (
    <AttachmentPill
      testID="composer-plugin-resource-attachment-pill"
      onOpen={handleOpen}
      onRemove={handleRemove}
      openAccessibilityLabel={openLabel(attachment.sourceTitle, attachment.item.identifier)}
      removeAccessibilityLabel={removeLabel(attachment.sourceTitle, attachment.item.identifier)}
      disabled={disabled}
    >
      <AttachmentLabel
        icon={icon}
        title={attachment.item.title}
        subtitle={`${attachment.sourceTitle} ${attachment.item.identifier}`}
      />
    </AttachmentPill>
  );
}
