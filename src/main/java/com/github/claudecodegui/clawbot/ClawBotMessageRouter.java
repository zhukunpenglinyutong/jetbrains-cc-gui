package com.github.claudecodegui.clawbot;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import java.util.function.Predicate;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.concurrent.atomic.AtomicBoolean;

/** Applies channel commands and explicit conversation-to-session routing. */
final class ClawBotMessageRouter {

    private static final int MAX_ROUTE_COUNT = 256;
    private static final int MAX_SEEN_MESSAGE_COUNT = 2_048;
    private static final int MAX_CONTROL_SELECTOR_LENGTH = 256;
    private static final long LIST_TTL_NANOS = TimeUnit.MINUTES.toNanos(5);

    private static boolean isKnownSlashCommand(String text) {
        String name = text.trim().split("\\s+", 2)[0].toLowerCase(Locale.ROOT);
        return switch (name) {
            case "/help", "/whoami", "/sessions", "/use", "/continue", "/answer", "/status", "/stop", "/new" -> true;
            default -> false;
        };
    }

    private final Map<String, RouteLease> routes = new LinkedHashMap<>();
    private final Map<String, SessionList> sessionLists = new LinkedHashMap<>();
    private final Map<String, String> invalidated = new LinkedHashMap<>();
    private final Map<String, Boolean> seenMessages = new LinkedHashMap<>();
    private final Map<String, Boolean> uncertainMessages = new LinkedHashMap<>();
    private final Map<String, Boolean> activeMessages = new LinkedHashMap<>();
    private final RouteStore routeStore;
    private final Predicate<String> senderAllowed;
    private final LongSupplier ticker;
    private final Supplier<ClawBotProgressSettings> settingsSupplier;
    private long routeRevision;
    private boolean routesDirty;
    private Consumer<ClawBotInboundMessage> previewRequester = message -> { };

    private final Map<String, InteractionRoute> interactions = new LinkedHashMap<>();

    private record InteractionRoute(ClawBotSessionTarget target, String sender, String messageId, String token) { }

    synchronized void setInteraction(ClawBotSessionSnapshot target, ClawBotInboundMessage source, String token) {
        String key = target.sessionHandleId();
        if (token.isEmpty()) {
            clearInteraction(key, source.messageId());
        } else {
            interactions.put(key, new InteractionRoute(ClawBotSessionTarget.of(target), source.fromUserId(), source.messageId(), token));
        }
    }

    synchronized void clearInteraction(String handle, String messageId) {
        InteractionRoute current = interactions.get(handle);
        if (current != null && current.messageId().equals(messageId)) {
            interactions.remove(handle);
        }
    }

    private boolean routeAnswer(ClawBotInboundMessage message, List<ClawBotSessionSnapshot> sessions,
                                ReplySender replySender, SessionCommandEnqueuer enqueuer, boolean explicit) throws IOException {
        ClawBotSessionSnapshot target = selectedSession(routeKey(message), sessions);
        InteractionRoute interaction = target == null ? null : interactions.get(target.sessionHandleId());
        if (interaction == null || !interaction.target().matches(target) || !interaction.sender().equals(message.fromUserId())) {
            if (explicit) {
                replySender.send(message, "当前选择的会话没有可回答的问题，或该问题不属于你。请查看最新问题提示。");
            }
            return explicit;
        }
        String text = explicit ? message.text().trim().replaceFirst("^/answer\\s*", "") : message.text();
        if (text.isBlank()) {
            replySender.send(message, "请在 /answer 后填写答案。");
            return true;
        }
        ClawBotInboundMessage answer = new ClawBotInboundMessage(message.messageId(), message.fromUserId(), message.contextToken(), text)
                .forTarget(target).forRoute(routes.get(routeKey(message)).revision()).forInteraction(interaction.token());
        if (!enqueuer.enqueue(target.sessionHandleId(), answer)) {
            replySender.send(message, "当前会话暂不可用，答案尚未提交，请稍后重试。");
        }
        return true;
    }

    synchronized void setPreviewRequester(Consumer<ClawBotInboundMessage> requester) {
        previewRequester = Objects.requireNonNull(requester, "requester");
    }

    ClawBotMessageRouter() {
        this(new MemoryRouteStore(), senderId -> true);
    }

    ClawBotMessageRouter(RouteStore routeStore, Predicate<String> senderAllowed) {
        this(routeStore, senderAllowed, System::nanoTime, ClawBotProgressSettings::defaults);
    }

    ClawBotMessageRouter(RouteStore routeStore, Predicate<String> senderAllowed, LongSupplier ticker) {
        this(routeStore, senderAllowed, ticker, ClawBotProgressSettings::defaults);
    }

    ClawBotMessageRouter(
            RouteStore routeStore,
            Predicate<String> senderAllowed,
            Supplier<ClawBotProgressSettings> settingsSupplier) {
        this(routeStore, senderAllowed, System::nanoTime, settingsSupplier);
    }

    ClawBotMessageRouter(
            RouteStore routeStore,
            Predicate<String> senderAllowed,
            LongSupplier ticker,
            Supplier<ClawBotProgressSettings> settingsSupplier) {
        this.routeStore = Objects.requireNonNull(routeStore, "routeStore");
        this.senderAllowed = Objects.requireNonNull(senderAllowed, "senderAllowed");
        this.ticker = Objects.requireNonNull(ticker, "ticker");
        this.settingsSupplier = Objects.requireNonNull(settingsSupplier, "settingsSupplier");
        try {
            routeStore.load();
        } catch (IOException error) {
            throw new IllegalStateException("CLAWBOT_ROUTE_STORE_UNAVAILABLE", error);
        }
    }

    synchronized void clear() throws IOException {
        IOException storeError = null;
        try {
            routeStore.clear();
            routesDirty = false;
        } catch (IOException error) {
            routesDirty = true;
            storeError = error;
        }
        interactions.clear();
        routes.clear();
        sessionLists.clear();
        invalidated.clear();
        seenMessages.clear();
        uncertainMessages.clear();
        activeMessages.clear();
        if (storeError != null) {
            throw storeError;
        }
    }

    synchronized void clearSeenMessages() {
        seenMessages.clear();
        uncertainMessages.clear();
        activeMessages.clear();
    }

    synchronized void clearRoute(String senderId) throws IOException {
        sessionLists.remove(senderId);
        invalidated.remove(senderId);
        try {
            removeRoute(senderId);
        } catch (IOException error) {
            routes.remove(senderId);
            throw error;
        }
    }

    synchronized void restoreSeenMessageIds(Collection<String> messageIds) {
        Objects.requireNonNull(messageIds, "messageIds");
        seenMessages.clear();
        activeMessages.clear();
        for (String messageId : messageIds) {
            if (messageId != null && !messageId.isBlank() && messageId.length() <= ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH
                    && messageId.chars().noneMatch(Character::isISOControl)) {
                seenMessages.put(messageId, Boolean.TRUE);
                trimSeenMessages();
            }
        }
    }

    synchronized List<String> seenMessageIdsSnapshot() {
        return List.copyOf(seenMessages.keySet());
    }

    synchronized void restoreUncertainMessageIds(Collection<String> messageIds) {
        Objects.requireNonNull(messageIds, "messageIds");
        uncertainMessages.clear();
        for (String messageId : messageIds) {
            if (messageId != null && seenMessages.containsKey(messageId) && !messageId.isBlank()
                    && messageId.length() <= ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH
                    && messageId.chars().noneMatch(Character::isISOControl)) {
                uncertainMessages.put(messageId, Boolean.TRUE);
            }
        }
    }

    synchronized List<String> uncertainMessageIdsSnapshot() {
        return List.copyOf(uncertainMessages.keySet());
    }

    void handle(
            ClawBotInboundMessage message,
            List<ClawBotSessionSnapshot> sessions,
            ReplySender replySender,
            MessageEnqueuer messageEnqueuer
    ) throws IOException {
        handle(message, sessions, replySender, messageEnqueuer, messageEnqueuer::enqueue,
                messageIds -> { }, (sessionHandleId, queuedMessage) -> true);
    }

    void handle(
            ClawBotInboundMessage message,
            List<ClawBotSessionSnapshot> sessions,
            ReplySender replySender,
            MessageEnqueuer messageEnqueuer,
            SessionCommandEnqueuer commandEnqueuer,
            MessageReceiptRecorder receiptRecorder
    ) throws IOException {
        handle(message, sessions, replySender, messageEnqueuer, commandEnqueuer, receiptRecorder,
                (sessionHandleId, queuedMessage) -> true);
    }

    void handle(
            ClawBotInboundMessage message,
            List<ClawBotSessionSnapshot> sessions,
            ReplySender replySender,
            MessageEnqueuer messageEnqueuer,
            SessionCommandEnqueuer commandEnqueuer,
            MessageReceiptRecorder receiptRecorder,
            ExecutionRecorder executionRecorder
    ) throws IOException {
        Objects.requireNonNull(message, "message");
        Objects.requireNonNull(sessions, "sessions");
        Objects.requireNonNull(replySender, "replySender");
        Objects.requireNonNull(messageEnqueuer, "messageEnqueuer");
        Objects.requireNonNull(commandEnqueuer, "commandEnqueuer");
        Objects.requireNonNull(receiptRecorder, "receiptRecorder");
        Objects.requireNonNull(executionRecorder, "executionRecorder");
        synchronized (this) {
            if (seenMessages.put(message.messageId(), Boolean.TRUE) != null) {
                if (uncertainMessages.containsKey(message.messageId())
                        && !activeMessages.containsKey(message.messageId())) {
                    boolean authorized = senderAllowed.test(message.fromUserId());
                    try {
                        if (authorized) {
                            replySender.sendUncertain(message,
                                    "上一条消息在网关切换前未能确认是否已提交给 IDE，当前未自动重放。请检查 IDE 会话后按需重新发送。\n\n消息状态：未知。");
                        }
                        uncertainMessages.remove(message.messageId());
                        receiptRecorder.record(List.copyOf(seenMessages.keySet()),
                                List.copyOf(uncertainMessages.keySet()));
                    } catch (IOException error) {
                        uncertainMessages.put(message.messageId(), Boolean.TRUE);
                        throw error;
                    }
                }
                return;
            }
            uncertainMessages.put(message.messageId(), Boolean.TRUE);
            trimSeenMessages();
            try {
                receiptRecorder.record(List.copyOf(seenMessages.keySet()),
                        List.copyOf(uncertainMessages.keySet()));
            } catch (IOException error) {
                seenMessages.remove(message.messageId());
                uncertainMessages.remove(message.messageId());
                throw error;
            }
            AtomicBoolean acceptedForIde = new AtomicBoolean();
            AtomicBoolean failedClosed = new AtomicBoolean();
            MessageEnqueuer trackedMessageEnqueuer = (sessionHandleId, queuedMessage) -> {
                boolean newlyRecorded = executionRecorder.recordAccepted(sessionHandleId, queuedMessage);
                if (!newlyRecorded) {
                    throw new IOException("CLAWBOT_EXECUTION_ALREADY_ACCEPTED");
                }
                boolean accepted;
                try {
                    accepted = messageEnqueuer.enqueue(sessionHandleId, queuedMessage);
                } catch (IOException | RuntimeException error) {
                    rollbackExecutionClaim(executionRecorder, queuedMessage.messageId(), newlyRecorded, error);
                    throw error;
                }
                if (accepted) {
                    acceptedForIde.set(true);
                } else {
                    rollbackExecutionClaim(executionRecorder, queuedMessage.messageId(), newlyRecorded, null);
                }
                return accepted;
            };
            SessionCommandEnqueuer trackedCommandEnqueuer = (sessionHandleId, queuedMessage) -> {
                boolean newlyRecorded = executionRecorder.recordAccepted(sessionHandleId, queuedMessage);
                if (!newlyRecorded) {
                    throw new IOException("CLAWBOT_EXECUTION_ALREADY_ACCEPTED");
                }
                boolean accepted;
                try {
                    accepted = commandEnqueuer.enqueue(sessionHandleId, queuedMessage);
                } catch (IOException | RuntimeException error) {
                    rollbackExecutionClaim(executionRecorder, queuedMessage.messageId(), newlyRecorded, error);
                    throw error;
                }
                if (accepted) {
                    acceptedForIde.set(true);
                } else {
                    rollbackExecutionClaim(executionRecorder, queuedMessage.messageId(), newlyRecorded, null);
                }
                return accepted;
            };
            try {
                String command = message.text().trim();
                if (!senderAllowed.test(message.fromUserId())) {
                    if ("/whoami".equalsIgnoreCase(command)) {
                        replySender.send(message,
                                "你的微信发送者 ID 是：" + message.fromUserId()
                                        + "。请在 IDE 的 Claw Bot 设置中明确授权该 ID。");
                    }
                    return;
                }
                if (senderAllowed instanceof SenderUsageRecorder recorder) {
                    recorder.recordUse(message.fromUserId());
                }
                if (message.action() == ClawBotInboundAction.UNSUPPORTED_MEDIA) {
                    replySender.send(message,
                            "当前仅支持文本消息；图片、语音和文件尚不支持。该消息未提交给 IDE。\n\n请重新发送为纯文本。");
                    return;
                }
                sweep(sessions);
                if (command.startsWith("/")) {
                    if (!isKnownSlashCommand(command)
                            && routeAnswer(message, sessions, replySender, trackedCommandEnqueuer, false)) {
                        return;
                    }
                    handleCommand(message, command, sessions, replySender,
                            trackedMessageEnqueuer, trackedCommandEnqueuer);
                    return;
                }
                NaturalCommand naturalCommand = parseNaturalCommand(command);
                if (naturalCommand != null) {
                    handleNaturalCommand(message, naturalCommand, sessions, replySender, trackedCommandEnqueuer);
                    return;
                }
                if (routeAnswer(message, sessions, replySender, trackedCommandEnqueuer, false)) {
                    return;
                }
                RouteSelection routeSelection = parseRouteSelection(command);
                if (routeSelection != null) {
                    handleRouteSelection(message, routeSelection.selector(), sessions, replySender);
                    return;
                }
                String routeKey = routeKey(message);
                ClawBotSessionSnapshot session = selectedSession(routeKey, sessions);
                if (session == null) {
                    String reason = invalidated.getOrDefault(routeKey, "请先选择目标会话。");
                    replySender.send(message, reason + "消息尚未提交。\n\n" + listSessions(routeKey, sessions));
                    return;
                }
                if (!trackedMessageEnqueuer.enqueue(session.sessionHandleId(),
                        message.forTarget(session).forRoute(routes.get(routeKey).revision()))) {
                    replySender.send(message,
                            "目标会话当前不可用，请发送 /sessions 刷新状态。");
                } else {
                    renewRoute(message, sessions);
                }
            } catch (IOException error) {
                failedClosed.set(true);
                throw error;
            } finally {
                if (acceptedForIde.get()) {
                    activeMessages.put(message.messageId(), Boolean.TRUE);
                } else {
                    activeMessages.remove(message.messageId());
                    if (failedClosed.get()) {
                        uncertainMessages.put(message.messageId(), Boolean.TRUE);
                    } else {
                        uncertainMessages.remove(message.messageId());
                    }
                }
                try {
                    receiptRecorder.record(List.copyOf(seenMessages.keySet()),
                            List.copyOf(uncertainMessages.keySet()));
                } catch (IOException error) {
                    uncertainMessages.put(message.messageId(), Boolean.TRUE);
                    throw error;
                }
            }
        }
    }

    private static void rollbackExecutionClaim(
            ExecutionRecorder executionRecorder, String messageId, boolean newlyRecorded, Throwable cause)
            throws IOException {
        if (!newlyRecorded) {
            return;
        }
        try {
            executionRecorder.rollbackAccepted(messageId);
        } catch (IOException error) {
            if (cause != null) {
                cause.addSuppressed(error);
                return;
            }
            throw error;
        }
    }

    synchronized void resolveUncertainMessage(String messageId, MessageReceiptRecorder receiptRecorder)
            throws IOException {
        Objects.requireNonNull(messageId, "messageId");
        Objects.requireNonNull(receiptRecorder, "receiptRecorder");
        boolean wasUncertain = uncertainMessages.remove(messageId) != null;
        boolean wasActive = activeMessages.remove(messageId) != null;
        if (!wasUncertain && !wasActive) {
            return;
        }
        try {
            receiptRecorder.record(List.copyOf(seenMessages.keySet()), List.copyOf(uncertainMessages.keySet()));
        } catch (IOException error) {
            if (wasUncertain) {
                uncertainMessages.put(messageId, Boolean.TRUE);
            }
            if (wasActive) {
                activeMessages.put(messageId, Boolean.TRUE);
            }
            throw error;
        }
    }

    private void handleCommand(
            ClawBotInboundMessage message,
            String command,
            List<ClawBotSessionSnapshot> sessions,
            ReplySender replySender,
            MessageEnqueuer messageEnqueuer,
            SessionCommandEnqueuer commandEnqueuer
    ) throws IOException {
        String[] parts = command.split("\\s+", 3);
        String name = parts[0].toLowerCase(Locale.ROOT);
        if (parts.length == 1 && List.of("/help", "/whoami", "/sessions", "/status").contains(name)) {
            renewRoute(message, sessions);
        }
        switch (name) {
            case "/help":
                replySender.send(message,
                        "【会话导航】\n\n/sessions — 查看项目和页签\n\n/use 1 — 选择编号为 1 的会话\n\n"
                                + "/status — 查看当前选择\n\n/use off — 清除当前选择\n\n"
                                + "【发送消息】\n\n选好会话后直接发送文字。\n\n"
                                + "/continue 1 消息内容 — 单次发送到指定会话\n\n"
                                + "【会话控制】\n\n停止当前会话 — 请求停止当前任务\n\n"
                                + "新建会话 — 替换当前页签会话，请谨慎使用\n\n"
                                + "【授权】\n\n/whoami — 查看发送者 ID，在 IDE 设置中授权\n\n"
                                + "等待回答时直接回复编号或文字；多题使用 Q编号: 答案。/answer 答案 — 回答当前问题\n\n"
                                + "编号以 /sessions 为准，/use 和 /continue 也支持会话 handle。");
                return;
            case "/whoami":
                replySender.send(message, "你的微信发送者 ID 是：" + message.fromUserId() + "。");
                return;
            case "/sessions":
                replySender.send(message, listSessions(routeKey(message), sessions));
                return;
            case "/use":
                handleUse(message, parts, sessions, replySender);
                return;
            case "/continue":
                handleContinue(message, parts, sessions, replySender, messageEnqueuer);
                return;
            case "/answer":
                routeAnswer(message, sessions, replySender, commandEnqueuer, true);
                return;
            case "/status":
                replySender.send(message, formatRoute(message, sessions));
                return;
            case "/stop":
            case "/new":
                replySender.send(message,
                        "该命令格式被禁止。请先用 /use 选择页签，再发送自然语言“停止当前会话”或“新建会话”。");
                return;
            default:
                replySender.send(message,
                        "未知命令，请发送 /help 查看可用命令。");
        }
    }

    private void handleNaturalCommand(
            ClawBotInboundMessage message,
            NaturalCommand command,
            List<ClawBotSessionSnapshot> sessions,
            ReplySender replySender,
            SessionCommandEnqueuer commandEnqueuer
    ) throws IOException {
        ClawBotSessionSnapshot target = resolveControlTarget(command.selector(), message, sessions);
        if (target == null) {
            replySender.send(message,
                    "无法唯一确定目标页签。请先发送 /sessions，再发送 /use <编号> 选择目标。");
            return;
        }
        ClawBotInboundAction action = command.action() == NaturalAction.STOP
                ? ClawBotInboundAction.INTERRUPT : ClawBotInboundAction.NEW_SESSION;
        ClawBotInboundMessage forwarded = ClawBotInboundMessage.command(message, action).forTarget(target);
        if (command.selector() == null || command.selector().isBlank()) {
            forwarded = forwarded.forRoute(routes.get(routeKey(message)).revision());
        }
        if (!commandEnqueuer.enqueue(target.sessionHandleId(), forwarded)) {
            replySender.send(message,
                    "目标页签当前不可用，控制操作未执行。");
            return;
        }
        renewRoute(message, sessions);
        String result = action == ClawBotInboundAction.INTERRUPT
                ? "已请求停止 " + displayName(target) + " 的当前会话。"
                : "已请求在 " + displayName(target) + " 中新建会话，当前页签会话将被覆盖。";
        replySender.send(message, result);
    }

    private void handleUse(
            ClawBotInboundMessage message,
            String[] parts,
            List<ClawBotSessionSnapshot> sessions,
            ReplySender replySender
    ) throws IOException {
        if (parts.length != 2 || parts[1].isBlank()) {
            replySender.send(message,
                    "用法：/use <编号或handle>，或 /use off。");
            return;
        }
        String routeKey = routeKey(message);
        if ("off".equalsIgnoreCase(parts[1])) {
            removeRoute(routeKey);
            invalidated.remove(routeKey);
            replySender.send(message, "已清除当前微信会话的页签选择。");
            return;
        }
        ClawBotSessionSnapshot target = resolveTarget(routeKey, parts[1], sessions);
        if (!isUsable(target)) {
            replySender.send(message,
                    "目标会话不存在、已离线或未开放接收能力，请发送 /sessions 查看。");
            return;
        }
        putRoute(routeKey, target);
        replySender.send(message,
                "已选择会话 " + displayName(target) + "，后续普通消息将发送到该会话。");
        previewRequester.accept(message.forTarget(target).forRoute(routes.get(routeKey).revision()));
    }

    private void handleContinue(
            ClawBotInboundMessage message,
            String[] parts,
            List<ClawBotSessionSnapshot> sessions,
            ReplySender replySender,
            MessageEnqueuer messageEnqueuer
    ) throws IOException {
        if (parts.length < 3 || parts[2].isBlank()) {
            replySender.send(message,
                    "用法：/continue <编号或handle> <消息>。");
            return;
        }
        ClawBotSessionSnapshot target = resolveTarget(routeKey(message), parts[1], sessions);
        if (!isUsable(target)) {
            replySender.send(message,
                    "目标会话不存在、已离线或未开放接收能力。");
            return;
        }
        ClawBotInboundMessage forwarded = new ClawBotInboundMessage(
                message.messageId(), message.fromUserId(), message.contextToken(), parts[2]);
        if (messageEnqueuer.enqueue(target.sessionHandleId(), forwarded.forTarget(target))) {
            replySender.send(message,
                    "消息已发送到会话 " + displayName(target) + "。");
        } else {
            replySender.send(message, "目标会话当前不可用。");
        }
    }

    private String formatSessions(List<ClawBotSessionSnapshot> sessions) {
        StringBuilder result = new StringBuilder("在线会话：");
        int displayIndex = 0;
        for (ClawBotSessionSnapshot session : sessions) {
            if (!isUsable(session)) {
                continue;
            }
            displayIndex++;
            result.append("\n\n").append(displayIndex).append(". ").append(displayName(session));
            if (session.status() == ClawBotSessionStatus.BUSY) {
                result.append("（处理中）");
            }
        }
        if (displayIndex == 0) {
            return "当前没有可接收微信消息的在线会话。";
        }
        return result.append("\n\n发送 /use 1 选择会话，再直接发送消息。编号有效期 5 分钟。").toString();
    }

    private void handleRouteSelection(
            ClawBotInboundMessage message, String selector,
            List<ClawBotSessionSnapshot> sessions, ReplySender replySender) throws IOException {
        List<ClawBotSessionSnapshot> usable = sessions.stream()
                .filter(ClawBotMessageRouter::isUsable).toList();
        ClawBotSessionSnapshot target = resolveNaturalSession(routeKey(message), selector, usable);
        if (target == null) {
            replySender.send(message, listSessions(routeKey(message), sessions));
            return;
        }
        putRoute(routeKey(message), target);
        replySender.send(message,
                "Selected session: " + displayName(target) + ". Future messages will be routed here.");
        previewRequester.accept(message.forTarget(target).forRoute(routes.get(routeKey(message)).revision()));
    }

    private ClawBotSessionSnapshot resolveNaturalSession(
            String sender, String selector, List<ClawBotSessionSnapshot> sessions) {
        ClawBotSessionSnapshot indexed = resolveTarget(sender, selector, sessions);
        if (indexed != null || selector.matches("[+-]?\\d+")) {
            return indexed;
        }
        String normalized = selector.trim().toLowerCase(Locale.ROOT);
        List<ClawBotSessionSnapshot> matches = sessions.stream()
                .filter(session -> session.projectDisplayName().toLowerCase(Locale.ROOT).equals(normalized)
                        || session.tabDisplayName().toLowerCase(Locale.ROOT).equals(normalized)
                        || displayName(session).toLowerCase(Locale.ROOT).equals(normalized)).toList();
        return matches.size() == 1 ? matches.get(0) : null;
    }

    private static RouteSelection parseRouteSelection(String text) {
        String normalized = text.toLowerCase(Locale.ROOT).trim();
        for (String prefix : List.of("use ", "select ", "switch to ", "choose ",
                "使用", "选择", "切换到", "切换至", "选中")) {
            if (normalized.startsWith(prefix.toLowerCase(Locale.ROOT))) {
                String selector = text.substring(prefix.length()).trim();
                return selector.isEmpty() ? null : new RouteSelection(selector);
            }
        }
        return null;
    }

    private String formatRoute(ClawBotInboundMessage message, List<ClawBotSessionSnapshot> sessions) {
        ClawBotSessionSnapshot target = selectedSession(routeKey(message), sessions);
        String result = target == null ? "当前微信会话尚未选择页签。"
                : "当前目标：" + displayName(target) + "\n\n提供方：" + target.provider()
                + "\n\n状态：" + (target.status() == ClawBotSessionStatus.BUSY ? "处理中" : "可接收消息");
        int uncertainCount = uncertainMessages.size()
                - (uncertainMessages.containsKey(message.messageId()) ? 1 : 0);
        if (uncertainCount > 0) {
            result += "\n\n待核验入站消息：" + uncertainCount
                    + "。网关无法确认这些消息是否已提交到 IDE，请检查 IDE 后按需重新发送；不会自动重放。";
        }
        return result;
    }

    private ClawBotSessionSnapshot resolveControlTarget(
            String selector, ClawBotInboundMessage message, List<ClawBotSessionSnapshot> sessions) {
        if (selector != null && !selector.isBlank()) {
            return resolveControlSelector(routeKey(message), selector, sessions);
        }
        ClawBotSessionSnapshot routed = selectedSession(routeKey(message), sessions);
        if (isControllable(routed)) {
            return routed;
        }
        return null;
    }

    private ClawBotSessionSnapshot resolveControlSelector(
            String sender, String selector, List<ClawBotSessionSnapshot> sessions) {
        ClawBotSessionSnapshot indexed = resolveTarget(sender, selector, sessions);
        if (isControllable(indexed)) {
            return indexed;
        }
        if (selector.matches("[+-]?\\d+")) {
            return null;
        }
        String normalized = selector.trim().toLowerCase(Locale.ROOT);
        List<ClawBotSessionSnapshot> matches = sessions.stream()
                .filter(ClawBotMessageRouter::isControllable)
                .filter(session -> session.projectDisplayName().toLowerCase(Locale.ROOT).equals(normalized)
                        || session.tabDisplayName().toLowerCase(Locale.ROOT).equals(normalized)
                        || displayName(session).toLowerCase(Locale.ROOT).equals(normalized))
                .toList();
        return matches.size() == 1 ? matches.get(0) : null;
    }

    private static NaturalCommand parseNaturalCommand(String text) {
        NaturalCommand command = parseNaturalCommand(text, NaturalAction.STOP, List.of(
                "stop current session", "stop generation", "cancel generation", "stop", "停止当前会话", "停止当前任务",
                "停止生成", "停止"));
        return command != null ? command : parseNaturalCommand(text, NaturalAction.NEW_SESSION, List.of(
                "new session", "start new session", "create new session", "新建会话", "创建新会话", "开启新会话"));
    }

    private static NaturalCommand parseNaturalCommand(String text, NaturalAction action, List<String> phrases) {
        String normalized = text.toLowerCase(Locale.ROOT);
        for (String phrase : phrases) {
            String normalizedPhrase = phrase.toLowerCase(Locale.ROOT);
            if (!normalized.equals(normalizedPhrase)
                    && !(normalized.startsWith(normalizedPhrase) && isSelectorSeparator(text.charAt(phrase.length())))) {
                continue;
            }
            String selector = normalized.equals(normalizedPhrase)
                    ? "" : text.substring(normalizedPhrase.length()).trim();
            selector = stripSelectorPrefix(selector);
            if (selector.length() <= MAX_CONTROL_SELECTOR_LENGTH && isSafeSelector(selector)) {
                return new NaturalCommand(action, selector);
            }
        }
        return null;
    }

    private static boolean isSelectorSeparator(char character) {
        return Character.isWhitespace(character) || character == ':' || character == '：';
    }

    private static String stripSelectorPrefix(String selector) {
        String result = selector;
        while (result.startsWith(":") || result.startsWith("：") || result.startsWith(" ")) {
            result = result.substring(1).trim();
        }
        return result;
    }

    private static boolean isSafeSelector(String selector) {
        return selector.chars().noneMatch(character -> Character.isISOControl(character) || character == '\n');
    }

    private void putRoute(String key, ClawBotSessionSnapshot session) throws IOException {
        Map<String, RouteLease> updated = new LinkedHashMap<>(routes);
        updated.put(key, new RouteLease(ClawBotSessionTarget.of(session), session.idleMillis(), ++routeRevision));
        while (updated.size() > MAX_ROUTE_COUNT) {
            updated.remove(updated.keySet().iterator().next());
        }
        saveRoutes(updated);
        routes.clear();
        routes.putAll(updated);
        invalidated.remove(key);
    }

    private void removeRoute(String key) throws IOException {
        if (!routes.containsKey(key)) {
            return;
        }
        routes.remove(key);
        routeRevision++;
        saveRoutes(routes);
    }

    synchronized void sweep(List<ClawBotSessionSnapshot> sessions) throws IOException {
        long idleTimeoutMillis = currentSettings().sessionIdleTimeoutMillis();
        interactions.values().removeIf(interaction -> sessions.stream().noneMatch(interaction.target()::matches));
        boolean changed = false;
        var iterator = routes.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, RouteLease> entry = iterator.next();
            RouteLease lease = entry.getValue();
            ClawBotSessionSnapshot target = findUsableSession(sessions, lease.target().handle());
            boolean invalid = !lease.target().matches(target);
            boolean expired = !invalid && (target.idleMillis() < lease.idleAtSelection()
                    || target.idleMillis() - lease.idleAtSelection() >= idleTimeoutMillis);
            if (invalid || expired) {
                invalidated.put(entry.getKey(), expired ? "会话选择已因空闲取消，请重新 /use。" : "目标会话已失效，请重新 /use。");
                iterator.remove();
                routeRevision++;
                changed = true;
            }
        }
        while (invalidated.size() > MAX_ROUTE_COUNT) {
            invalidated.remove(invalidated.keySet().iterator().next());
        }
        long now = ticker.getAsLong();
        sessionLists.values().removeIf(list -> now < list.createdAt() || now - list.createdAt() >= LIST_TTL_NANOS);
        if (changed || routesDirty) {
            saveRoutes(routes);
        }
    }

    private void saveRoutes(Map<String, RouteLease> values) throws IOException {
        Map<String, String> serialized = new LinkedHashMap<>();
        values.forEach((sender, lease) -> {
            JsonObject value = new JsonObject();
            value.addProperty("version", 1);
            value.add("target", lease.target().toJson());
            value.addProperty("idleAtSelection", lease.idleAtSelection());
            value.addProperty("routeRevision", lease.revision());
            serialized.put(sender, value.toString());
        });
        routesDirty = true;
        routeStore.save(serialized);
        routesDirty = false;
    }

    private ClawBotProgressSettings currentSettings() {
        try {
            ClawBotProgressSettings settings = settingsSupplier.get();
            return settings == null ? ClawBotProgressSettings.defaults() : settings;
        } catch (RuntimeException ignored) {
            return ClawBotProgressSettings.defaults();
        }
    }

    private String listSessions(String sender, List<ClawBotSessionSnapshot> sessions) {
        sessionLists.put(sender, new SessionList(sessions.stream().filter(ClawBotMessageRouter::isUsable)
                .map(ClawBotSessionTarget::of).toList(), ticker.getAsLong()));
        while (sessionLists.size() > MAX_ROUTE_COUNT) {
            sessionLists.remove(sessionLists.keySet().iterator().next());
        }
        return formatSessions(sessions);
    }

    private ClawBotSessionSnapshot selectedSession(String sender, List<ClawBotSessionSnapshot> sessions) {
        RouteLease lease = routes.get(sender);
        if (lease == null) {
            return null;
        }
        ClawBotSessionSnapshot target = findUsableSession(sessions, lease.target().handle());
        return lease.target().matches(target) ? target : null;
    }

    private void renewRoute(ClawBotInboundMessage message, List<ClawBotSessionSnapshot> sessions) throws IOException {
        ClawBotSessionSnapshot target = selectedSession(routeKey(message), sessions);
        if (target != null) {
            String sender = routeKey(message);
            Map<String, RouteLease> updated = new LinkedHashMap<>(routes);
            updated.put(sender, new RouteLease(ClawBotSessionTarget.of(target), target.idleMillis(), routes.get(sender).revision()));
            saveRoutes(updated);
            routes.putAll(updated);
        }
    }

    synchronized boolean acceptsPending(ClawBotInboundMessage message) {
        if (!senderAllowed.test(message.fromUserId()) || message.target() == null) {
            return false;
        }
        if (message.routeRevision() == 0) {
            return true;
        }
        RouteLease lease = routes.get(message.fromUserId());
        return lease != null && lease.revision() == message.routeRevision() && lease.target().equals(message.target());
    }

    private record RouteLease(ClawBotSessionTarget target, long idleAtSelection, long revision) {
    }

    private record SessionList(List<ClawBotSessionTarget> targets, long createdAt) {
    }

    private void trimSeenMessages() {
        while (seenMessages.size() > MAX_SEEN_MESSAGE_COUNT) {
            String oldestMessageId = seenMessages.keySet().iterator().next();
            seenMessages.remove(oldestMessageId);
            uncertainMessages.remove(oldestMessageId);
            activeMessages.remove(oldestMessageId);
        }
    }

    private ClawBotSessionSnapshot resolveTarget(
            String sender, String selector, List<ClawBotSessionSnapshot> sessions) {
        try {
            int index = Integer.parseInt(selector);
            SessionList listed = sessionLists.get(sender);
            long now = ticker.getAsLong();
            if (listed == null || now < listed.createdAt() || now - listed.createdAt() >= LIST_TTL_NANOS
                    || index < 1 || index > listed.targets().size()) {
                return null;
            }
            ClawBotSessionTarget target = listed.targets().get(index - 1);
            return sessions.stream().filter(target::matches).filter(ClawBotMessageRouter::isUsable).findFirst().orElse(null);
        } catch (NumberFormatException ignored) {
            if (selector.matches("[+-]?\\d+")) {
                return null;
            }
        }
        return sessions.stream()
                .filter(session -> session.sessionHandleId().equals(selector))
                .findFirst()
                .orElse(null);
    }

    private static ClawBotSessionSnapshot findUsableSession(
            List<ClawBotSessionSnapshot> sessions, String sessionHandleId) {
        if (sessionHandleId == null) {
            return null;
        }
        return sessions.stream()
                .filter(session -> session.sessionHandleId().equals(sessionHandleId) && isUsable(session))
                .findFirst()
                .orElse(null);
    }

    private static boolean isUsable(ClawBotSessionSnapshot session) {
        return session != null
                && (session.status() == ClawBotSessionStatus.ONLINE
                || session.status() == ClawBotSessionStatus.BUSY)
                && session.capabilities().contains("INBOUND")
                && session.capabilities().contains("ROUTING_V2") && !"legacy".equals(session.generation())
                && session.idleMillis() >= 0 && session.idleMillis() < Long.MAX_VALUE;
    }

    private static boolean isControllable(ClawBotSessionSnapshot session) {
        return isUsable(session) && session.capabilities().contains("CONTROL");
    }

    private static String displayName(ClawBotSessionSnapshot session) {
        return session.projectDisplayName() + " / " + session.tabDisplayName();
    }

    private static String routeKey(ClawBotInboundMessage message) {
        return message.fromUserId();
    }

    @FunctionalInterface
    interface ReplySender {
        void send(String toUserId, String contextToken, String text) throws IOException;

        default void send(ClawBotInboundMessage message, String text) throws IOException {
            send(message.fromUserId(), message.contextToken(), text);
        }

        default void sendUncertain(ClawBotInboundMessage message, String text) throws IOException {
            send(message, text);
        }
    }

    @FunctionalInterface
    interface MessageEnqueuer {
        boolean enqueue(String sessionHandleId, ClawBotInboundMessage message) throws IOException;
    }

    @FunctionalInterface
    interface SessionCommandEnqueuer {
        boolean enqueue(String sessionHandleId, ClawBotInboundMessage message) throws IOException;
    }

    @FunctionalInterface
    interface MessageReceiptRecorder {
        void record(List<String> messageIds) throws IOException;

        default void record(List<String> messageIds, List<String> uncertainMessageIds) throws IOException {
            record(messageIds);
        }
    }

    @FunctionalInterface
    interface ExecutionRecorder {
        boolean recordAccepted(String sessionHandleId, ClawBotInboundMessage message) throws IOException;

        default void rollbackAccepted(String messageId) throws IOException {
        }
    }

    interface SenderUsageRecorder extends Predicate<String> {
        void recordUse(String senderId);
    }

    interface RouteStore {

        Map<String, String> load() throws IOException;

        void save(Map<String, String> routes) throws IOException;

        void clear() throws IOException;
    }

    private static final class MemoryRouteStore implements RouteStore {

        @Override
        public Map<String, String> load() {
            return Map.of();
        }

        @Override
        public void save(Map<String, String> routes) {
        }

        @Override
        public void clear() {
        }
    }

    private record NaturalCommand(NaturalAction action, String selector) {
    }

    private record RouteSelection(String selector) {
    }

    private enum NaturalAction {
        STOP,
        NEW_SESSION
    }
}
