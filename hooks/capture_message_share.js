'use strict';

function asText(value) {
    try { return value == null ? '' : String(value); } catch (e) { return ''; }
}

function emit(type, value) {
    send({type: type, value: value, captured_at_ms: Date.now()});
}

function listToArray(value) {
    var result = [];
    try {
        if (value == null) return result;
        var iterator = value.iterator();
        while (iterator.hasNext()) result.push(asText(iterator.next()));
    } catch (e) {
        result.push(asText(value));
    }
    return result;
}

function invokeAppShare(isAllowSeo) {
    var result = {ok: false, matched: 0, invoked: 0};
    Java.perform(function () {
        Java.choose('com.larus.bmhome.chat.model.MessageShareViewModel', {
            onMatch: function (viewModel) {
                result.matched += 1;
                try {
                    viewModel.shareMessage(!!isAllowSeo);
                    result.invoked += 1;
                    emit('app_internal_share_invoked', {is_allow_seo: !!isAllowSeo});
                } catch (e) {
                    emit('app_internal_share_error', {error: asText(e)});
                }
            },
            onComplete: function () {}
        });
    });
    result.ok = result.invoked > 0;
    return result;
}

rpc.exports = {
    // Calls the App's own ViewModel entry point. No HTTP request is built here.
    appshare: function (isAllowSeo) {
        return invokeAppShare(!!isAllowSeo);
    }
};

var sseStates = {};
var sseStreamKeys = null;
var sseStreamSequence = 0;
var sseHookedClasses = {};
var sseInputHooked = {};
var ssePrepareHooked = {};
var shareTriggeredForSse = false;
var lastSseConversationId = '';
var lastSseMessageId = '';
var lastSseMessageIds = [];
var activeShareHelpers = [];
var responseCaptured = false;
var awaitingAutoShareResponse = false;
var sseLogOut = null;
var sseLogPath = '';

function openSseLog() {
    try {
        if (sseLogOut != null) return;
        var app = Java.use('android.app.ActivityThread').currentApplication();
        var dir = app.getApplicationContext().getExternalFilesDir(null).getAbsolutePath();
        sseLogPath = dir + '/doubao_complete_sse.log';
        sseLogOut = Java.use('java.io.FileOutputStream').$new(sseLogPath, false);
        emit('sse_log_ready', {path: sseLogPath, encoding: 'UTF-8'});
    } catch (e) {
        emit('sse_log_error', {error: asText(e)});
    }
}

function writeSseLine(line) {
    try {
        if (sseLogOut == null) openSseLog();
        if (sseLogOut == null) return;
        var JString = Java.use('java.lang.String');
        var data = JString.$new(asText(line)).getBytes('UTF-8');
        sseLogOut.write(data);
        sseLogOut.flush();
    } catch (e) {
        emit('sse_log_error', {error: asText(e)});
    }
}

function isCompletionUrl(url) {
    return asText(url).indexOf('/chat/completion') >= 0;
}

function completionBodyText(req) {
    try {
        var body = req.getBody();
        if (!body) return '';
        var BAOS = Java.use('java.io.ByteArrayOutputStream');
        var os = BAOS.$new();
        body.writeTo(os);
        return asText(os.toString('UTF-8'));
    } catch (e) { return ''; }
}

function captureCompletionContext(req) {
    try {
        var raw = completionBodyText(req);
        if (!raw) return;
        emit('completion_request_body', {text: raw, encoding: 'UTF-8'});
        var parsed = JSON.parse(raw);
        function collect(value) {
            if (!value || typeof value != 'object') return;
            Object.keys(value).forEach(function (key) {
                var v = value[key];
                if ((key == 'conversation_id' || key == 'conversationId' || key == 'conv_id') && lastSseConversationId == '') lastSseConversationId = asText(v);
                if (key == 'message_id' && asText(v) != '' && lastSseMessageIds.indexOf(asText(v)) < 0) lastSseMessageIds.push(asText(v));
                if (key == 'message_id_list' && v && typeof v == 'object') Object.keys(v).forEach(function (i) { var id = asText(v[i]); if (id != '' && lastSseMessageIds.indexOf(id) < 0) lastSseMessageIds.push(id); });
                collect(v);
            });
        }
        collect(parsed);
        if (lastSseConversationId != '') emit('sse_conversation_context', {conversation_id: lastSseConversationId});
    } catch (e) {}
}

function urlOfCall(call) {
    try { return asText(call.retrofitRequest.value.getUrl()); } catch (e) { return ''; }
}

function looksLikeSseEnd(parsed) {
    if (parsed == null || typeof parsed != 'object') return false;
    // end_type=1 and end_type=2 are intermediate phases. Nested
    // content_block.is_finish only marks one block as complete.
    return asText(parsed.end_type) == '3';
}

function triggerShareAfterSse(url, reason) {
    if (shareTriggeredForSse) return;
    shareTriggeredForSse = true;
    emit('sse_answer_finished', {url: url, reason: reason});
    // Let the final message commit to the App's conversation state first.
    setTimeout(function () {
        var result = invokeInternalShareRequest();
        emit('app_internal_share_after_sse', result);
    }, 1500);
}

function invokeInternalShareRequest() {
    var result = {ok: false, conversation_id: lastSseConversationId, message_id: lastSseMessageId};
    Java.perform(function () {
        try {
            if (lastSseConversationId == '') {
                result.error = 'conversation_id_not_found';
                emit('app_internal_share_request_error', result);
                return;
            }
            var ArrayList = Java.use('java.util.ArrayList');
            var ids = ArrayList.$new();
            var idValues = lastSseMessageIds.length ? lastSseMessageIds : [lastSseMessageId];
            idValues.forEach(function (id) { if (id != '') ids.add(id); });
            var Request = Java.use('com.larus.bmhome.share.network.f');
            var request = Request.$new(
                lastSseConversationId, ids,
                Java.use('java.lang.Boolean').valueOf(true),
                Java.use('java.lang.Boolean').valueOf(false),
                Java.use('java.lang.Boolean').valueOf(false), 0
            );
            var Helper = Java.use('com.larus.bmhome.share.network.PreloadMessageShareHelper');
            var helper = Helper.$new();
            activeShareHelpers.push(helper);
            // A heap-selected ViewModel may already be cleared, which leaves
            // its ViewModelScope cancelled. GlobalScope keeps the App-owned
            // coroutine alive until this internal request returns.
            var GlobalScope = Java.use('kotlinx.coroutines.GlobalScope');
            var scope = GlobalScope.INSTANCE.value;
            awaitingAutoShareResponse = true;
            helper.a(scope, request);
            result.ok = true;
            emit('app_internal_share_request_invoked', result);
            pollShareHelperResponse(helper, 0);
        } catch (e) { result.error = asText(e); emit('app_internal_share_request_error', result); }
    });
    return result;
}

// Reuse the App's normal selection path. G2() is the current eligible
// conversation message list; enterSelectMode() fills the private shareMsgIds
// map, and shareMessage() then builds the exact request used by the UI.
function invokeAppSelectionThenShare() {
    var result = {ok: false, components: 0, selected: 0, ids: []};
    Java.perform(function () {
        try {
            var ActionType = Java.use('com.larus.bmhome.chat.component.share.IChatMessageShareAbility$ActionType');
            var HashMap = Java.use('java.util.HashMap');
            var ArrayList = Java.use('java.util.ArrayList');
            var vmFound = null;
            Java.choose('com.larus.bmhome.chat.component.share.ChatShareBottomComponent', {
                onMatch: function (component) {
                    if (vmFound != null) return;
                    result.components += 1;
                    try {
                        var list = component.G2();
                        if (list == null || list.size() == 0) return;
                        var chosen = null;
                        for (var i = 0; i < list.size(); i++) {
                            var msgId = '';
                            try { msgId = asText(list.get(i).getMessageId()); } catch (e) {}
                            if (msgId != '' && lastSseMessageIds.indexOf(msgId) >= 0) chosen = list.get(i);
                        }
                        if (chosen == null) chosen = list.get(list.size() - 1);
                        var vm = component.L2();
                        var current = ArrayList.$new();
                        for (var j = 0; j < list.size(); j++) current.add(list.get(j));
                        vm.enterSelectMode(ActionType.SHARE.value, chosen, current, HashMap.$new());
                        vmFound = vm;
                        result.selected = list.size();
                        for (var k = 0; k < list.size(); k++) {
                            try { result.ids.push(asText(list.get(k).getMessageId())); } catch (e) {}
                        }
                        emit('app_share_selection_populated', {count: result.selected, message_id_list: result.ids});
                    } catch (e) { emit('app_share_selection_error', {error: asText(e)}); }
                },
                onComplete: function () {}
            });
            if (vmFound != null) {
                result.ok = true;
                setTimeout(function () {
                    Java.perform(function () {
                        try { vmFound.shareMessage(false); emit('app_internal_share_after_selection', {ok: true}); }
                        catch (e) { emit('app_internal_share_after_selection_error', {error: asText(e)}); }
                    });
                }, 700);
            }
        } catch (e) { result.error = asText(e); }
    });
    return result;
}

function pollShareHelperResponse(helper, attempt) {
    if (responseCaptured || attempt > 20) return;
    setTimeout(function () {
        Java.perform(function () {
            try {
                var response = helper.a.value;
                if (response != null) {
                    var data = response.getData();
                    if (data != null && asText(data.getClass().getName()) == 'com.larus.bmhome.share.network.SaveMessageShareInfo') {
                        responseCaptured = true;
                        emit('message_share_response', {
                            code: asText(response.getCode()),
                            msg: asText(response.getMsg()),
                            share_id: asText(data.getShareId()),
                            share_url: asText(data.getShareUrl()),
                            qr_code_url: asText(data.getQrCodeUrl())
                        });
                        return;
                    }
                }
            } catch (e) { emit('message_share_response_poll_error', {error: asText(e)}); }
            pollShareHelperResponse(helper, attempt + 1);
        });
    }, 500);
}

function inspectSseLine(url, line) {
    if (line.indexOf('data:') != 0) return;
    var raw = line.substring(5).trim();
    if (raw == '[DONE]') {
        triggerShareAfterSse(url, 'DONE');
        return;
    }
    try {
        if (raw) {
            var parsed = JSON.parse(raw);
            function collect(value) {
                if (!value || typeof value != 'object') return;
                Object.keys(value).forEach(function (key) {
                    var v = value[key];
                    if (key == 'conversation_id' && lastSseConversationId == '') lastSseConversationId = asText(v);
                    if (key == 'message_id' && lastSseMessageId == '') lastSseMessageId = asText(v);
                    if (key == 'message_id' && asText(v) != '' && lastSseMessageIds.indexOf(asText(v)) < 0) lastSseMessageIds.push(asText(v));
                    collect(v);
                });
            }
            collect(parsed);
            if (looksLikeSseEnd(parsed)) triggerShareAfterSse(url, 'end_type_3');
        }
    } catch (e) {}
}

function decodeSseBytes(bytes) {
    try {
        var signed = [];
        for (var i = 0; i < bytes.length; i++) signed.push(bytes[i] > 127 ? bytes[i] - 256 : bytes[i]);
        var JString = Java.use('java.lang.String');
        return JString.$new(Java.array('byte', signed), 'UTF-8').toString();
    } catch (e) { return ''; }
}

function feedSse(stream, bytes, off, len, url) {
    if (sseStreamKeys == null) return;
    var mappedKey = sseStreamKeys.get(stream);
    if (mappedKey == null) return;
    var key = asText(mappedKey);
    var state = sseStates[key];
    if (!state) return;
    for (var i = 0; i < len; i++) state.bytes.push(bytes[off + i] & 255);
    var p;
    while ((p = state.bytes.indexOf(10)) >= 0) {
        var lineBytes = state.bytes.splice(0, p + 1);
        var line = decodeSseBytes(lineBytes);
        writeSseLine(line);
        inspectSseLine(url, line);
    }
}

function installSseReadHook(stream, url) {
    try {
        // Class-wide hooks also see unrelated HTTP streams. Register only
        // completion instances, using Java object identity across wrappers.
        if (sseStreamKeys == null) sseStreamKeys = Java.use('java.util.IdentityHashMap').$new();
        if (!sseStreamKeys.containsKey(stream)) {
            var streamKey = String(++sseStreamSequence);
            sseStreamKeys.put(stream, Java.use('java.lang.String').$new(streamKey));
            sseStates[streamKey] = {url: url, bytes: [], reading: false};
        }
        var name = stream.$className;
        if (!name || sseHookedClasses[name]) return;
        var C = Java.use(name);
        C.read.overloads.forEach(function (ov) {
            ov.implementation = function () {
                var mappedKey = sseStreamKeys.get(this);
                var state = mappedKey == null ? null : sseStates[asText(mappedKey)];
                if (!state || state.reading) return ov.apply(this, arguments);
                // read(byte[]) may delegate to read(byte[], off, len).
                state.reading = true;
                try {
                    var n = ov.apply(this, arguments);
                    if (arguments.length == 0 && n >= 0) feedSse(this, [n], 0, 1, state.url);
                    else if (n > 0 && arguments.length >= 3) feedSse(this, arguments[0], arguments[1], n, state.url);
                    else if (n > 0 && arguments.length == 1) feedSse(this, arguments[0], 0, n, state.url);
                    if (n < 0) {
                        if (state.bytes.length) {
                            var tail = decodeSseBytes(state.bytes);
                            writeSseLine(tail);
                            inspectSseLine(state.url, tail);
                        }
                        sseStreamKeys.remove(this);
                        delete sseStates[asText(mappedKey)];
                    }
                    return n;
                } finally {
                    state.reading = false;
                }
            };
        });
        sseHookedClasses[name] = true;
        emit('sse_read_hooked', {class_name: name, url: url});
    } catch (e) { emit('sse_read_hook_error', {error: asText(e)}); }
}

function installSseHooks() {
    Java.perform(function () {
        ['com.bytedance.frameworks.baselib.network.http.cronet.impl.BaseCronetSsCall',
         'com.bytedance.frameworks.baselib.network.http.ok3.impl.Ok3SsCall'].forEach(function (name) {
            try {
                var C = Java.use(name);
                if (sseInputHooked[name]) return;
                sseInputHooked[name] = true;
                var input = C.inputStream.overload();
                input.implementation = function () {
                    var url = urlOfCall(this);
                    var stream = input.call(this);
                    if (isCompletionUrl(url) && stream &&
                        (sseStreamKeys == null || !sseStreamKeys.containsKey(stream))) {
                        openSseLog();
                        shareTriggeredForSse = false;
                        responseCaptured = false;
                        if (stream) installSseReadHook(stream, url);
                    }
                    return stream;
                };
                emit('sse_input_hooked', name);
            } catch (e) {}
        });
        ['com.bytedance.frameworks.baselib.network.http.cronet.impl.BaseCronetSsCall',
         'com.bytedance.frameworks.baselib.network.http.ok3.impl.Ok3SsCall'].forEach(function (name) {
            try {
                var C2 = Java.use(name);
                if (ssePrepareHooked[name]) return;
                ssePrepareHooked[name] = true;
                C2.prepareNetworkRequest.overloads.forEach(function (ov) {
                    ov.implementation = function () {
                        var url = arguments.length > 0 ? asText(arguments[0]) : '';
                        var req = arguments.length > 1 ? arguments[1] : null;
                        if (isCompletionUrl(url) && req) {
                            // A transport retry belongs to the same answer and
                            // may omit the identifiers from the first request.
                            if (!/[?&]is_retry=1(?:&|$)/.test(url)) {
                                lastSseConversationId = '';
                                lastSseMessageId = '';
                                lastSseMessageIds = [];
                            }
                            captureCompletionContext(req);
                        }
                        return ov.apply(this, arguments);
                    };
                });
            } catch (e) {}
        });
    });
}

setTimeout(installSseHooks, 0);
setTimeout(installSseHooks, 5000);
setTimeout(installSseHooks, 15000);

Java.perform(function () {
    var requestCount = 0;
    var responseSeen = {};

    try {
        var Request = Java.use('com.larus.bmhome.share.network.f');
        var requestInit = Request.$init.overload(
            'java.lang.String', 'java.util.List', 'java.lang.Boolean',
            'java.lang.Boolean', 'java.lang.Boolean', 'int'
        );
        requestInit.implementation = function (convId, messageIds, generateTitle, allowSeo, totalConversation, mask) {
            var result = requestInit.call(this, convId, messageIds, generateTitle, allowSeo, totalConversation, mask);
            requestCount += 1;
            emit('message_share_request', {
                sequence: requestCount,
                conv_id: asText(convId),
                message_id_list: listToArray(messageIds),
                enable_generate_title: generateTitle == null ? null : !!generateTitle.booleanValue(),
                is_allow_seo: allowSeo == null ? null : !!allowSeo.booleanValue(),
                share_total_conversation: totalConversation == null ? null : !!totalConversation.booleanValue()
            });
            return result;
        };
        emit('hooked', 'SaveMessageRequest.<init>');
    } catch (e) {
        emit('hook_error', {target: 'SaveMessageRequest.<init>', error: asText(e)});
    }

    try {
        var Info = Java.use('com.larus.bmhome.share.network.SaveMessageShareInfo');
        var getShareId = Info.getShareId.overload();
        var getShareUrl = Info.getShareUrl.overload();
        var getQrCodeUrl = Info.getQrCodeUrl.overload();
        function snapshot(object) {
            var key = asText(Java.use('java.lang.System').identityHashCode(object));
            if (responseSeen[key]) return;
            var shareId = asText(getShareId.call(object));
            var shareUrl = asText(getShareUrl.call(object));
            var qrCodeUrl = asText(getQrCodeUrl.call(object));
            if (shareId == '' && shareUrl == '' && qrCodeUrl == '') return;
            responseSeen[key] = true;
            emit('message_share_response', {
                share_id: shareId,
                share_url: shareUrl,
                qr_code_url: qrCodeUrl
            });
        }
        // Keep the original getters untouched. Calling them from inside a
        // hooked getter can recurse on some Frida/ART builds.
        emit('hooked', 'SaveMessageShareInfo.getShareId/getShareUrl/getQrCodeUrl');
    } catch (e) {
        emit('hook_error', {target: 'SaveMessageShareInfo getters', error: asText(e)});
    }

    try {
        var BizResponse = Java.use('com.larus.network.bean.BizResponse');
        var bizInit = BizResponse.$init.overload('long', 'java.lang.String', 'java.lang.String', 'java.lang.Object');
        bizInit.implementation = function (code, msg, payload, data) {
            var result = bizInit.call(this, code, msg, payload, data);
            try {
                if (data != null && asText(data.getClass().getName()) == 'com.larus.bmhome.share.network.SaveMessageShareInfo') {
                    emit('message_share_response', {
                        code: asText(code),
                        msg: asText(msg),
                        share_id: asText(data.getShareId()),
                        share_url: asText(data.getShareUrl()),
                        qr_code_url: asText(data.getQrCodeUrl())
                    });
                }
            } catch (e) { emit('message_share_response_error', {error: asText(e)}); }
            return result;
        };
        emit('hooked', 'BizResponse.<init>(code,msg,payload,data)');
        var getData = BizResponse.getData.overload();
        getData.implementation = function () { return getData.call(this); };
        emit('hooked', 'BizResponse.getData');
    } catch (e) {
        emit('hook_error', {target: 'BizResponse.getData', error: asText(e)});
    }

    // shareMessage() publishes the successful API result through
    // MutableLiveData.postValue(), bypassing the constructor/getter paths
    // above. Hook this terminal app-internal callback as well.
    try {
        var LiveData = Java.use('androidx.lifecycle.MutableLiveData');
        var postValue = LiveData.postValue.overload('java.lang.Object');
        postValue.implementation = function (value) {
            try {
                if (value != null) {
                    var cls = asText(value.getClass().getName());
                    // Smali: Pair(BizResponse<SaveMessageShareInfo>, ShareItemConfig).
                    if (cls == 'kotlin.Pair') {
                        emit('message_share_live_data_value', {class_name: cls});
                        var pairField = value.getClass().getDeclaredField('first');
                        pairField.setAccessible(true);
                        var response = pairField.get(value);
                        if (response != null && asText(response.getClass().getName()) == 'com.larus.network.bean.BizResponse') {
                            var bf = response.getClass().getDeclaredField('data');
                            bf.setAccessible(true);
                            var payload = bf.get(response);
                            if (payload != null && asText(payload.getClass().getName()) == 'com.larus.bmhome.share.network.SaveMessageShareInfo') {
                                var pf = payload.getClass();
                                var sf = pf.getDeclaredField('shareUrl'); sf.setAccessible(true);
                                var idf = pf.getDeclaredField('shareId'); idf.setAccessible(true);
                                var qf = pf.getDeclaredField('qrCodeUrl'); qf.setAccessible(true);
                                emit('message_share_response_reflection', {
                                    share_id: asText(idf.get(payload)),
                                    share_url: asText(sf.get(payload)),
                                    qr_code_url: asText(qf.get(payload))
                                });
                            }
                        }
                    }
                }
            } catch (e) { emit('message_share_response_live_data_error', {error: asText(e)}); }
            return postValue.call(this, value);
        };
        emit('hooked', 'MutableLiveData.postValue');
    } catch (e) {
        emit('hook_error', {target: 'MutableLiveData.postValue', error: asText(e)});
    }

    try {
        var ApiSuccess = Java.use('ej9.a$b');
        var successInit = ApiSuccess.$init.overload(
            'com.larus.network.bean.BizResponse',
            'com.larus.network.http.ApiRespInterceptedException'
        );
        successInit.implementation = function (bizResponse, intercepted) {
            var result = successInit.call(this, bizResponse, intercepted);
            if (awaitingAutoShareResponse && bizResponse != null) {
                try {
                    var dataField = bizResponse.getClass().getDeclaredField('data');
                    dataField.setAccessible(true);
                    var data = dataField.get(bizResponse);
                    var dataClass = data == null ? '' : asText(data.getClass().getName());
                    emit('app_internal_share_api_success', {data_class: dataClass});
                    if (dataClass == 'com.larus.bmhome.share.network.SaveMessageShareInfo') {
                        var infoClass = data.getClass();
                        var shareUrlField = infoClass.getDeclaredField('shareUrl'); shareUrlField.setAccessible(true);
                        var shareIdField = infoClass.getDeclaredField('shareId'); shareIdField.setAccessible(true);
                        var qrField = infoClass.getDeclaredField('qrCodeUrl'); qrField.setAccessible(true);
                        responseCaptured = true;
                        awaitingAutoShareResponse = false;
                        emit('message_share_response_auto', {
                            share_id: asText(shareIdField.get(data)),
                            share_url: asText(shareUrlField.get(data)),
                            qr_code_url: asText(qrField.get(data))
                        });
                    }
                } catch (e) { emit('app_internal_share_api_success_error', {error: asText(e)}); }
            }
            return result;
        };

        var ApiError = Java.use('ej9.a$a');
        var errorInit = ApiError.$init.overload('int', 'java.lang.String', 'java.lang.Throwable');
        errorInit.implementation = function (code, msg, throwable) {
            var result = errorInit.call(this, code, msg, throwable);
            if (awaitingAutoShareResponse) {
                awaitingAutoShareResponse = false;
                emit('app_internal_share_api_error', {
                    code: code,
                    msg: asText(msg),
                    throwable: asText(throwable)
                });
            }
            return result;
        };
        emit('hooked', 'ApiResult.Success/Error');
    } catch (e) {
        emit('hook_error', {target: 'ApiResult.Success/Error', error: asText(e)});
    }

    emit('message_share_hook_ready', {pid: Process.id});
});
