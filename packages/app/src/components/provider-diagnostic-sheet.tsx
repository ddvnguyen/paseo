import * as Clipboard from "expo-clipboard";
import { AlertTriangle, Copy, FileText, Plus, RotateCw, Trash2 } from "lucide-react-native";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ModelDisableSwitch } from "@/components/provider-model-toggle";
import { ProviderMaxContextField } from "@/components/provider-max-context-field";
import { buildProviderMaxContextPatch } from "@/components/provider-max-context";
// @ts-expect-error - provider-model-prefix-field.ts wins extensionless resolution;
// the component lives in the sibling .tsx and must be imported with its extension.
import { ProviderModelPrefixField } from "@/components/provider-model-prefix-field.tsx";
import {
  buildProviderModelPrefixPatch,
  buildProviderSubModelPrefixPatch,
} from "@/components/provider-model-prefix-field";
import {
  buildSubProviderModelSections,
  collectSubProviderIds,
  type SubProviderModelSection,
} from "@/provider-selection/provider-model-prefix";
import { ScrollableCodeSurface, SurfaceCard } from "@/components/ui/scrollable-code-surface";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { formatTimeAgo } from "@/utils/time";
import { compareMatchScores, scoreTextFields } from "@getpaseo/protocol/search/text-match";
import type { AgentModelDefinition, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";
import {
  resolveProviderDiscoveredModels,
  type ProviderDiscoveredModelsCache,
} from "./provider-diagnostic-models";

interface ProviderDiagnosticSheetProps {
  provider: string;
  visible: boolean;
  onClose: () => void;
  serverId: string;
}

function rankModels<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  if (!query.trim()) return items;
  const scored = items
    .map((item) => ({ item, score: scoreTextFields(query, fields(item)) }))
    .filter(
      (entry): entry is { item: T; score: NonNullable<typeof entry.score> } => entry.score !== null,
    );
  scored.sort((a, b) => compareMatchScores(a.score, b.score));
  return scored.map((entry) => entry.item);
}

export function DiscoveredModelRow({
  model,
  serverId,
  provider,
  catalogIds,
}: {
  model: AgentModelDefinition;
  serverId: string;
  provider: string;
  catalogIds: string[];
}) {
  return (
    <View style={sheetStyles.modelRow} testID={`provider-sheet-model-row-${model.id}`}>
      <Text style={sheetStyles.modelTitle} numberOfLines={1}>
        {model.label}
      </Text>
      <Text
        style={sheetStyles.monoHint}
        numberOfLines={1}
        selectable
        dataSet={CODE_SURFACE_DATASET}
      >
        {model.id}
      </Text>
      {model.description ? (
        <Text style={sheetStyles.descriptionInline} numberOfLines={1}>
          {model.description}
        </Text>
      ) : null}
      <View style={sheetStyles.modelRowFiller} />
      <ModelDisableSwitch
        serverId={serverId}
        provider={provider}
        modelId={model.id}
        modelLabel={model.label}
        catalogIds={catalogIds}
        style={sheetStyles.toggleColumn}
        hintStyle={sheetStyles.toggleHint}
      />
    </View>
  );
}

export function CustomModelRow({
  model,
  serverId,
  provider,
  catalogIds,
  deleting,
  onDelete,
}: {
  model: ProviderProfileModel;
  serverId: string;
  provider: string;
  catalogIds: string[];
  deleting: boolean;
  onDelete: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const handleDelete = useCallback(() => onDelete(model.id), [model.id, onDelete]);
  const deleteButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      deleting ? sheetStyles.disabled : null,
    ],
    [deleting],
  );

  return (
    <View style={sheetStyles.modelRow} testID={`provider-sheet-custom-model-row-${model.id}`}>
      <Text style={sheetStyles.modelTitle} numberOfLines={1}>
        {model.label}
      </Text>
      <Text
        style={sheetStyles.monoHint}
        numberOfLines={1}
        selectable
        dataSet={CODE_SURFACE_DATASET}
      >
        {model.id}
      </Text>
      <View style={sheetStyles.modelRowFiller} />
      <ModelDisableSwitch
        serverId={serverId}
        provider={provider}
        modelId={model.id}
        modelLabel={model.label}
        catalogIds={catalogIds}
        style={sheetStyles.toggleColumn}
        hintStyle={sheetStyles.toggleHint}
      />
      <Pressable
        onPress={handleDelete}
        disabled={deleting}
        hitSlop={8}
        style={deleteButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("settings.providers.models.removeModel", { id: model.id })}
      >
        <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />
      </Pressable>
    </View>
  );
}

/**
 * One sub-provider's block: its tag field with that sub-provider's models listed
 * directly beneath it.
 *
 * Its own component rather than an inline block in the map so the save callback
 * is created once per sub-provider instead of on every render of the sheet,
 * which would re-render every tag field whenever anything else in the modal
 * moved. The rows come along for the ride, but their array identity only changes
 * when the served models or the search query do — both memoized upstream — so the
 * sheet's "fetched at" clock tick cannot re-render every row.
 *
 * The field and the rows share one card on purpose: the card style carries a
 * border radius and a border, so a second card underneath would draw a doubled
 * rounded seam. Model rows already separate themselves with a top hairline, which
 * is exactly the rule the field needs above the first row.
 */
function ProviderSubModelGroup({
  subProviderId,
  models,
  storedPrefix,
  onSave,
  isSaving,
  visible,
  serverId,
  provider,
  catalogIds,
}: {
  subProviderId: string;
  models: readonly AgentModelDefinition[];
  storedPrefix: string | undefined;
  onSave: (subProviderId: string, prefix: string | undefined) => void;
  isSaving: boolean;
  visible: boolean;
  serverId: string;
  provider: string;
  catalogIds: string[];
}) {
  const { t } = useTranslation();
  const handleSave = useCallback(
    (prefix: string | undefined) => {
      onSave(subProviderId, prefix);
    },
    [onSave, subProviderId],
  );

  return (
    <View
      style={sheetStyles.section}
      // The group is the unit a user reads and QC counts: one per sub-provider,
      // containing both the tag field and the rows that field governs.
      testID={`provider-model-sub-section-${subProviderId}`}
    >
      <SectionHeader
        title={t("settings.providers.modelPrefix.subProviderSection", {
          subProvider: subProviderId,
        })}
        // Absent rather than zero while a search hides every row: a "0" reads as
        // "this sub-provider serves nothing", which is not what an empty search
        // result means.
        count={models.length > 0 ? models.length : undefined}
      />
      <View style={settingsStyles.card}>
        <View style={sheetStyles.limitRow}>
          <ProviderModelPrefixField
            storedPrefix={storedPrefix}
            onSave={handleSave}
            isSaving={isSaving}
            visible={visible}
            idSuffix={subProviderId}
          />
        </View>
        {models.map((model) => (
          <DiscoveredModelRow
            key={model.id}
            model={model}
            serverId={serverId}
            provider={provider}
            catalogIds={catalogIds}
          />
        ))}
      </View>
    </View>
  );
}

function SectionHeader({ title, count, hint }: { title: string; count?: number; hint?: string }) {
  return (
    <View style={sheetStyles.sectionHeader}>
      <Text style={settingsStyles.sectionHeaderTitle}>{title}</Text>
      <View style={sheetStyles.sectionHeaderMeta}>
        {count !== undefined ? (
          <Text style={settingsStyles.sectionHeaderTitle}>{count}</Text>
        ) : null}
        {count !== undefined && hint ? (
          <Text style={settingsStyles.sectionHeaderTitle}>·</Text>
        ) : null}
        {hint ? <Text style={settingsStyles.sectionHeaderTitle}>{hint}</Text> : null}
      </View>
    </View>
  );
}

function AddCustomModelSubSheet({
  provider,
  serverId,
  visible,
  onClose,
  refresh,
}: {
  provider: string;
  serverId: string;
  visible: boolean;
  onClose: () => void;
  refresh: (providers?: AgentProvider[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const additionalModels = useMemo(
    () => config?.providers?.[provider]?.additionalModels ?? [],
    [config?.providers, provider],
  );
  const trimmed = input.trim();
  const canAdd = trimmed.length > 0 && !additionalModels.some((model) => model.id === trimmed);

  useEffect(() => {
    if (!visible) {
      setInput("");
      setError(null);
    }
  }, [visible]);

  const handleAdd = useCallback(() => {
    if (!canAdd) return;
    setError(null);
    setSaving(true);
    void patchConfig({
      providers: {
        [provider]: {
          additionalModels: [...additionalModels, { id: trimmed, label: trimmed }],
        },
      },
    })
      .then(() => refresh([provider]))
      .then(() => onClose())
      .catch((err) => {
        setError(err instanceof Error ? err.message : t("settings.providers.models.failedToSave"));
      })
      .finally(() => setSaving(false));
  }, [additionalModels, canAdd, onClose, patchConfig, provider, refresh, t, trimmed]);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.providers.models.addCustomTitle") }),
    [t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={420}
      snapPoints={ADD_SNAP_POINTS}
      testID="add-custom-model-sheet"
    >
      <View style={sheetStyles.formGroup}>
        <Text style={sheetStyles.formLabel}>{t("settings.providers.models.modelId")}</Text>
        <AdaptiveTextInput
          initialValue={input}
          resetKey={`add-custom-${visible}`}
          onChangeText={setInput}
          onSubmitEditing={handleAdd}
          placeholder={t("settings.providers.models.modelIdPlaceholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          // @ts-expect-error - outlineStyle is web-only
          style={[sheetStyles.formInput, isWeb && { outlineStyle: "none" }]}
        />
        {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
        <View style={sheetStyles.formActions}>
          <Button variant="secondary" size="sm" onPress={onClose} disabled={saving}>
            {t("common.actions.cancel")}
          </Button>
          <Button variant="default" size="sm" onPress={handleAdd} disabled={!canAdd || saving}>
            {saving ? t("settings.providers.models.adding") : t("settings.providers.models.add")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function DiagnosticSubSheet({
  provider,
  serverId,
  visible,
  onClose,
}: {
  provider: string;
  serverId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchDiagnostic = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.getProviderDiagnostic(provider);
      setDiagnostic(result.diagnostic);
    } catch (err) {
      setDiagnostic(
        err instanceof Error ? err.message : t("settings.providers.diagnostic.failedToFetch"),
      );
    } finally {
      setLoading(false);
    }
  }, [client, provider, t]);

  useEffect(() => {
    if (visible) {
      void fetchDiagnostic();
    } else {
      setDiagnostic(null);
    }
  }, [visible, fetchDiagnostic]);

  const refreshButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      loading ? sheetStyles.disabled : null,
    ],
    [loading],
  );

  const handleRefreshPress = useCallback(() => {
    void fetchDiagnostic();
  }, [fetchDiagnostic]);

  const copyButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && Boolean(diagnostic) && sheetStyles.iconButtonHovered,
      diagnostic ? null : sheetStyles.disabled,
    ],
    [diagnostic],
  );

  const handleCopyPress = useCallback(() => {
    if (!diagnostic) return;
    void Clipboard.setStringAsync(diagnostic)
      .then(() => toast.copied(t("settings.providers.diagnostic.copyLabel")))
      .catch(() => toast.error(t("settings.providers.diagnostic.copyFailed")));
  }, [diagnostic, t, toast]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.providers.diagnostic.title"),
      actions: (
        <View style={sheetStyles.headerActions}>
          <Pressable
            onPress={handleCopyPress}
            disabled={!diagnostic}
            hitSlop={8}
            style={copyButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={t("settings.providers.diagnostic.copyAccessibility")}
          >
            <Copy size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Pressable
            onPress={handleRefreshPress}
            disabled={loading}
            hitSlop={8}
            style={refreshButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={
              loading
                ? t("settings.providers.diagnostic.refreshingAccessibility")
                : t("settings.providers.diagnostic.refreshAccessibility")
            }
          >
            {loading ? (
              <LoadingSpinner size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            ) : (
              <RotateCw size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            )}
          </Pressable>
        </View>
      ),
    }),
    [
      copyButtonStyle,
      diagnostic,
      handleCopyPress,
      handleRefreshPress,
      loading,
      refreshButtonStyle,
      t,
      theme.colors.foregroundMuted,
      theme.iconSize.sm,
    ],
  );

  let body: React.ReactNode;
  if (loading && !diagnostic) {
    body = (
      <SurfaceCard key={visible ? "visible" : "hidden"}>
        <View style={sheetStyles.codeBlockLoading}>
          <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>{t("settings.providers.diagnostic.running")}</Text>
        </View>
      </SurfaceCard>
    );
  } else if (diagnostic) {
    body = (
      <ScrollableCodeSurface key={visible ? "visible" : "hidden"} maxHeight={480}>
        {diagnostic}
      </ScrollableCodeSurface>
    );
  } else {
    body = (
      <SurfaceCard key={visible ? "visible" : "hidden"}>
        <View style={sheetStyles.codeBlockLoading}>
          <Text style={sheetStyles.mutedText}>{t("settings.providers.diagnostic.none")}</Text>
        </View>
      </SurfaceCard>
    );
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={DIAGNOSTIC_SNAP_POINTS}
      scrollable={false}
      testID="provider-diagnostic-sheet"
    >
      {body}
    </AdaptiveModalSheet>
  );
}

interface ProviderModalBodyProps {
  serverId: string;
  provider: string;
  catalogIds: string[];
  discoveredCount: number;
  additionalCount: number;
  providerSnapshotRefreshing: boolean;
  providerErrorMessage: string | null;
  modelsRefreshing: boolean;
  searchActive: boolean;
  /**
   * The models list already grouped by sub-provider: one entry per served
   * sub-provider carrying its own rows, plus a remainder entry for models that
   * declare none. A single source for both "which fields render" and "which rows
   * render under them" — deriving them separately is how a row ends up under a
   * header that does not exist.
   */
  modelSections: SubProviderModelSection<AgentModelDefinition>[];
  filteredCustom: ProviderProfileModel[];
  deletingModelId: string | null;
  visible: boolean;
  maxContextTokens: number | undefined;
  isSavingMaxContext: boolean;
  modelPrefix: string | undefined;
  isSavingModelPrefix: boolean;
  /** Stored per-sub-provider tags, keyed by sub-provider id. */
  modelPrefixes: Readonly<Record<string, string>>;
  /** Sub-provider ids with a save in flight. */
  savingSubModelPrefixIds: ReadonlySet<string>;
  onRefresh: () => void;
  onDeleteCustom: (modelId: string) => void;
  onSaveMaxContext: (tokens: number | undefined) => void;
  onSaveModelPrefix: (prefix: string | undefined) => void;
  onSaveSubModelPrefix: (subProviderId: string, prefix: string | undefined) => void;
  theme: { iconSize: { md: number }; colors: { foregroundMuted: string } };
}

interface ProviderSheetFooterInput {
  fetchedAtLabel: string | null;
  isCompact: boolean;
  modelsRefreshing: boolean;
  t: TFunction;
  onOpenAddSheet: () => void;
  onOpenDiagSheet: () => void;
  onRefreshModels: () => void;
}

function renderProviderSheetFooter({
  fetchedAtLabel,
  isCompact,
  modelsRefreshing,
  t,
  onOpenAddSheet,
  onOpenDiagSheet,
  onRefreshModels,
}: ProviderSheetFooterInput) {
  const contentStyle = isCompact ? sheetStyles.compactFooterContent : sheetStyles.footerContent;
  const actionsStyle = isCompact ? sheetStyles.compactFooterActions : sheetStyles.footerActions;
  const buttonStyle = isCompact ? sheetStyles.compactFooterButton : null;
  const metaStyle = isCompact
    ? [sheetStyles.footerMeta, sheetStyles.compactFooterMeta]
    : sheetStyles.footerMeta;

  return (
    <View style={contentStyle}>
      {fetchedAtLabel || !isCompact ? (
        <Text style={metaStyle} numberOfLines={1}>
          {fetchedAtLabel ? t("settings.providers.models.updated", { time: fetchedAtLabel }) : ""}
        </Text>
      ) : null}
      <View style={actionsStyle}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={Plus}
          onPress={onOpenAddSheet}
          style={buttonStyle}
        >
          {t("settings.providers.models.addModel")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={FileText}
          onPress={onOpenDiagSheet}
          style={buttonStyle}
        >
          {t("settings.providers.diagnostic.button")}
        </Button>
        <Button
          variant="default"
          size="sm"
          leftIcon={modelsRefreshing ? undefined : RotateCw}
          onPress={onRefreshModels}
          disabled={modelsRefreshing}
          style={buttonStyle}
        >
          {modelsRefreshing
            ? t("settings.providers.diagnostic.refreshing")
            : t("settings.providers.diagnostic.refresh")}
        </Button>
      </View>
    </View>
  );
}

function ProviderModalBody(props: ProviderModalBodyProps) {
  const { t } = useTranslation();
  const {
    serverId,
    provider,
    catalogIds,
    discoveredCount,
    additionalCount,
    providerSnapshotRefreshing,
    providerErrorMessage,
    modelsRefreshing,
    searchActive,
    modelSections,
    filteredCustom,
    deletingModelId,
    visible,
    maxContextTokens,
    isSavingMaxContext,
    modelPrefix,
    isSavingModelPrefix,
    modelPrefixes,
    savingSubModelPrefixIds,
    onRefresh,
    onDeleteCustom,
    onSaveMaxContext,
    onSaveModelPrefix,
    onSaveSubModelPrefix,
    theme,
  } = props;

  // The whole grouped list, counted for the empty states below. Derived rather
  // than passed separately so the states and the rendered rows cannot disagree.
  const filteredDiscoveredCount = modelSections.reduce(
    (total, section) => total + section.models.length,
    0,
  );

  if (discoveredCount === 0 && additionalCount === 0 && providerSnapshotRefreshing) {
    return (
      <View style={sheetStyles.emptyState}>
        <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.loading")}</Text>
      </View>
    );
  }
  if (discoveredCount === 0 && additionalCount === 0 && providerErrorMessage) {
    return (
      <View style={sheetStyles.emptyState}>
        <AlertTriangle size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
        <Text style={sheetStyles.mutedText}>{providerErrorMessage}</Text>
        <Button variant="default" size="sm" onPress={onRefresh} disabled={modelsRefreshing}>
          {modelsRefreshing
            ? t("settings.providers.models.retrying")
            : t("settings.providers.models.retry")}
        </Button>
      </View>
    );
  }
  if (filteredDiscoveredCount === 0 && filteredCustom.length === 0 && searchActive) {
    return (
      <View style={sheetStyles.emptyState}>
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.noSearchMatches")}</Text>
      </View>
    );
  }
  if (discoveredCount === 0 && additionalCount === 0) {
    return (
      <View style={sheetStyles.emptyState}>
        <Text style={sheetStyles.mutedText}>{t("settings.providers.models.noneDetected")}</Text>
      </View>
    );
  }
  return (
    <>
      <View style={sheetStyles.section}>
        <SectionHeader title={t("settings.providers.maxContext.section")} />
        <View style={settingsStyles.card}>
          <View style={sheetStyles.limitRow}>
            <ProviderMaxContextField
              storedTokens={maxContextTokens}
              onSave={onSaveMaxContext}
              isSaving={isSavingMaxContext}
              visible={visible}
            />
          </View>
        </View>
      </View>
      <View style={sheetStyles.section}>
        <SectionHeader title={t("settings.providers.modelPrefix.section")} />
        <View style={settingsStyles.card}>
          <View style={sheetStyles.limitRow}>
            <ProviderModelPrefixField
              storedPrefix={modelPrefix}
              onSave={onSaveModelPrefix}
              isSaving={isSavingModelPrefix}
              visible={visible}
            />
          </View>
        </View>
      </View>
      {modelSections.map((section) =>
        // The remainder entry has no tag field to sit under — a model that
        // declares no sub-provider has no key to configure — so it renders as a
        // plain list under the header the flat list already used. A provider with
        // no sub-providers lands here alone and looks exactly as it did before
        // grouping existed.
        section.subProviderId === undefined ? (
          <View
            key={REMAINDER_SECTION_KEY}
            style={sheetStyles.section}
            testID={REMAINDER_SECTION_TEST_ID}
          >
            <SectionHeader
              title={t("settings.providers.models.discovered")}
              count={section.models.length}
            />
            <View style={settingsStyles.card}>
              {section.models.map((model) => (
                <DiscoveredModelRow
                  key={model.id}
                  model={model}
                  serverId={serverId}
                  provider={provider}
                  catalogIds={catalogIds}
                />
              ))}
            </View>
          </View>
        ) : (
          <ProviderSubModelGroup
            key={section.subProviderId}
            subProviderId={section.subProviderId}
            models={section.models}
            serverId={serverId}
            provider={provider}
            catalogIds={catalogIds}
            storedPrefix={modelPrefixes[section.subProviderId]}
            onSave={onSaveSubModelPrefix}
            isSaving={savingSubModelPrefixIds.has(section.subProviderId)}
            visible={visible}
          />
        ),
      )}
      {filteredCustom.length > 0 ? (
        <View style={sheetStyles.section}>
          <SectionHeader
            title={t("settings.providers.models.custom")}
            count={filteredCustom.length}
          />
          <View style={settingsStyles.card}>
            {filteredCustom.map((model) => (
              <CustomModelRow
                key={model.id}
                model={model}
                serverId={serverId}
                provider={provider}
                catalogIds={catalogIds}
                deleting={deletingModelId === model.id}
                onDelete={onDeleteCustom}
              />
            ))}
          </View>
        </View>
      ) : null}
    </>
  );
}

export function ProviderDiagnosticSheet({
  provider,
  visible,
  onClose,
  serverId,
}: ProviderDiagnosticSheetProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const { entries: snapshotEntries, refresh, isRefreshing } = useProvidersSnapshot(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [query, setQuery] = useState("");
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [diagSheetOpen, setDiagSheetOpen] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [savingMaxContext, setSavingMaxContext] = useState(false);
  const [savingModelPrefix, setSavingModelPrefix] = useState(false);
  // Keyed by sub-provider id rather than one flag: saving one tag must not lock
  // every other sub-provider's field on a provider that serves many.
  const [savingSubModelPrefixIds, setSavingSubModelPrefixIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const providerLabel = resolveProviderLabel(provider, snapshotEntries);
  const providerEntry = useMemo(
    () => snapshotEntries?.find((entry) => entry.provider === provider),
    [snapshotEntries, provider],
  );
  const additionalModels = useMemo(
    () => config?.providers?.[provider]?.additionalModels ?? [],
    [config?.providers, provider],
  );
  const maxContextTokens = config?.providers?.[provider]?.maxContextTokens;
  const modelPrefix = config?.providers?.[provider]?.modelPrefix;
  const modelPrefixes = useMemo(
    () => config?.providers?.[provider]?.modelPrefixes ?? {},
    [config?.providers, provider],
  );
  const providerSnapshotRefreshing = providerEntry?.status === "loading";
  const providerErrorMessage =
    providerEntry?.status === "error"
      ? (providerEntry.error ?? t("settings.providers.diagnostic.unknownError"))
      : null;
  const modelsRefreshing = isRefreshing || providerSnapshotRefreshing;

  const stableDiscoveredRef = useRef<ProviderDiscoveredModelsCache | null>(null);
  const currentModels = providerEntry?.models;
  const { models: discoveredModels, cache: nextDiscoveredCache } = resolveProviderDiscoveredModels({
    serverId,
    provider,
    currentModels,
    providerSnapshotRefreshing,
    previousCache: stableDiscoveredRef.current,
  });
  stableDiscoveredRef.current = nextDiscoveredCache;

  // One tag field per sub-provider this provider actually serves. Derived from
  // the served models rather than a static list, so the fields appear and
  // disappear with the user's credentials and nothing has to be maintained by
  // hand. Deliberately NOT derived from the search-filtered models: a search box
  // must not make a configured tag unreachable.
  const subProviderIds = useMemo(() => collectSubProviderIds(discoveredModels), [discoveredModels]);

  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setClockTick((tick) => tick + 1), 10_000);
    return () => clearInterval(id);
  }, [visible]);
  const fetchedAtLabel = useMemo(() => {
    if (!providerEntry?.fetchedAt) return null;
    void clockTick;
    return formatTimeAgo(new Date(providerEntry.fetchedAt));
  }, [providerEntry?.fetchedAt, clockTick]);

  useEffect(() => {
    if (!visible) {
      setQuery("");
      setAddSheetOpen(false);
      setDiagSheetOpen(false);
    }
  }, [visible]);

  const q = query.trim();
  const filteredDiscovered = useMemo(
    () => rankModels(discoveredModels, q, (m) => [m.label, m.id, m.description ?? ""]),
    [discoveredModels, q],
  );
  const filteredCustom = useMemo(
    () => rankModels(additionalModels, q, (m) => [m.label, m.id]),
    [additionalModels, q],
  );
  // The fields come from the unfiltered models and the rows from the filtered
  // ones, so a search narrows the list without narrowing what is configurable.
  const modelSections = useMemo(
    () => buildSubProviderModelSections(subProviderIds, filteredDiscovered),
    [subProviderIds, filteredDiscovered],
  );
  const catalogIds = useMemo(
    () => [
      ...discoveredModels.map((model) => model.id),
      ...additionalModels.map((model) => model.id),
    ],
    [discoveredModels, additionalModels],
  );

  const handleRefreshModels = useCallback(() => {
    void refresh([provider]);
  }, [provider, refresh]);

  const handleOpenAddSheet = useCallback(() => setAddSheetOpen(true), []);
  const handleCloseAddSheet = useCallback(() => setAddSheetOpen(false), []);
  const handleOpenDiagSheet = useCallback(() => setDiagSheetOpen(true), []);
  const handleCloseDiagSheet = useCallback(() => setDiagSheetOpen(false), []);

  const handleSaveMaxContext = useCallback(
    (tokens: number | undefined) => {
      if (savingMaxContext) return;
      setSavingMaxContext(true);
      void patchConfig({ providers: buildProviderMaxContextPatch(provider, tokens) })
        // The ceiling is applied when the catalog is served, so the new value is
        // not observable until the provider is re-read.
        .then(() => refresh([provider]))
        .catch((err: unknown) => {
          Alert.alert(
            t("settings.providers.maxContext.failedToSaveTitle"),
            err instanceof Error ? err.message : t("settings.providers.maxContext.failedToSave"),
          );
        })
        .finally(() => setSavingMaxContext(false));
    },
    [patchConfig, provider, refresh, savingMaxContext, t],
  );

  const handleSaveModelPrefix = useCallback(
    (prefix: string | undefined) => {
      if (savingModelPrefix) return;
      setSavingModelPrefix(true);
      void patchConfig({ providers: buildProviderModelPrefixPatch(provider, prefix) })
        .catch((err: unknown) => {
          Alert.alert(
            t("settings.providers.modelPrefix.failedToSaveTitle"),
            err instanceof Error ? err.message : t("settings.providers.modelPrefix.failedToSave"),
          );
        })
        .finally(() => {
          void refresh([provider]);
          setSavingModelPrefix(false);
        });
    },
    [patchConfig, provider, refresh, savingModelPrefix, t],
  );

  const handleSaveSubModelPrefix = useCallback(
    (subProviderId: string, prefix: string | undefined) => {
      if (savingSubModelPrefixIds.has(subProviderId)) return;
      setSavingSubModelPrefixIds((current) => new Set(current).add(subProviderId));
      void patchConfig({
        providers: buildProviderSubModelPrefixPatch(provider, subProviderId, prefix),
      })
        .catch((err: unknown) => {
          Alert.alert(
            t("settings.providers.modelPrefix.failedToSaveTitle"),
            err instanceof Error ? err.message : t("settings.providers.modelPrefix.failedToSave"),
          );
        })
        .finally(() => {
          void refresh([provider]);
          setSavingSubModelPrefixIds((current) => {
            const next = new Set(current);
            next.delete(subProviderId);
            return next;
          });
        });
    },
    [patchConfig, provider, refresh, savingSubModelPrefixIds, t],
  );

  const handleDeleteCustom = useCallback(
    (modelId: string) => {
      setDeletingModelId(modelId);
      void patchConfig({
        providers: {
          [provider]: {
            additionalModels: additionalModels.filter((model) => model.id !== modelId),
          },
        },
      })
        .then(() => refresh([provider]))
        .finally(() => {
          setDeletingModelId((current) => (current === modelId ? null : current));
        });
    },
    [additionalModels, patchConfig, provider, refresh],
  );

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title: providerLabel,
      search: {
        onChange: setQuery,
        placeholder: t("settings.providers.models.searchPlaceholder"),
        testID: "provider-settings-search",
      },
    }),
    [providerLabel, t],
  );

  return (
    <>
      <AdaptiveModalSheet
        header={sheetHeader}
        visible={visible}
        onClose={onClose}
        testID="provider-settings-sheet"
        footer={renderProviderSheetFooter({
          fetchedAtLabel,
          isCompact,
          modelsRefreshing,
          t,
          onOpenAddSheet: handleOpenAddSheet,
          onOpenDiagSheet: handleOpenDiagSheet,
          onRefreshModels: handleRefreshModels,
        })}
        snapPoints={MAIN_SNAP_POINTS}
      >
        <ProviderModalBody
          serverId={serverId}
          provider={provider}
          catalogIds={catalogIds}
          discoveredCount={discoveredModels.length}
          additionalCount={additionalModels.length}
          providerSnapshotRefreshing={providerSnapshotRefreshing}
          providerErrorMessage={providerErrorMessage}
          modelsRefreshing={modelsRefreshing}
          searchActive={Boolean(q)}
          modelSections={modelSections}
          filteredCustom={filteredCustom}
          deletingModelId={deletingModelId}
          visible={visible}
          maxContextTokens={maxContextTokens}
          isSavingMaxContext={savingMaxContext}
          modelPrefix={modelPrefix}
          isSavingModelPrefix={savingModelPrefix}
          modelPrefixes={modelPrefixes}
          savingSubModelPrefixIds={savingSubModelPrefixIds}
          onRefresh={handleRefreshModels}
          onDeleteCustom={handleDeleteCustom}
          onSaveMaxContext={handleSaveMaxContext}
          onSaveModelPrefix={handleSaveModelPrefix}
          onSaveSubModelPrefix={handleSaveSubModelPrefix}
          theme={theme}
        />
      </AdaptiveModalSheet>
      <AddCustomModelSubSheet
        provider={provider}
        serverId={serverId}
        visible={addSheetOpen}
        onClose={handleCloseAddSheet}
        refresh={refresh}
      />
      <DiagnosticSubSheet
        provider={provider}
        serverId={serverId}
        visible={diagSheetOpen}
        onClose={handleCloseDiagSheet}
      />
    </>
  );
}

const sheetStyles = StyleSheet.create((theme) => ({
  mutedText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  // minWidth: 0 is load-bearing, not a nicety. A single-line model id only ellipsizes when the
  // Text is width-constrained, so the row needs flexShrink: 1 — and on web a CSS flex item
  // defaults to min-width: auto, which pins the id to its intrinsic width and pushes the
  // trailing switch off the row even with flexShrink: 1. The two properties travel together.
  monoHint: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 0,
  },
  descriptionInline: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  formInput: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  disabled: {
    opacity: 0.5,
  },
  section: {
    marginBottom: theme.spacing[4],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  sectionHeaderMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  limitRow: {
    padding: theme.spacing[4],
  },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  modelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
    minWidth: 0,
  },
  modelRowFiller: {
    flex: 1,
  },
  // The trailing slot holds the rail, so it never shrinks. The cap bounds only the variable-width
  // part — the "last model" hint — which would otherwise widen the slot enough to push the delete
  // button off a narrow row. The switch is a fixed 34px track and is never the constraint.
  toggleColumn: {
    alignItems: "flex-end",
    gap: theme.spacing[1],
    flexShrink: 0,
    maxWidth: "45%",
  },
  toggleHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyState: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
    gap: theme.spacing[3],
  },
  footerContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  compactFooterContent: {
    flex: 1,
    gap: theme.spacing[2],
  },
  footerMeta: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  compactFooterMeta: {
    flex: 0,
  },
  footerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  compactFooterActions: {
    gap: theme.spacing[2],
  },
  compactFooterButton: {
    alignSelf: "stretch",
  },
  formGroup: {
    gap: theme.spacing[3],
  },
  formLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  codeBlockLoading: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));

const MAIN_SNAP_POINTS = ["65%", "92%"];
const ADD_SNAP_POINTS = ["40%"];
const DIAGNOSTIC_SNAP_POINTS = ["50%", "85%"];
// React keys, and a sub-provider id can never be this. Keeps the remainder
// section distinct from every sub-provider group without widening the section
// type with a sentinel id that would then reach a tag field.
const REMAINDER_SECTION_KEY = "__no-sub-provider__";
const REMAINDER_SECTION_TEST_ID = "provider-model-remainder-section";
