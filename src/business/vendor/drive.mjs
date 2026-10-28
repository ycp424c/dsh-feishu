import { Type, optionalPositiveIntegerSchema, readPositiveIntegerParam, normalizeOptionalString, normalizeLowercaseStringOrEmpty, readStringValue, uniqueStrings, formatErrorMessage, formatFeishuApiError, jsonResult, extensionForMime, listEnabledFeishuAccounts, resolveToolsConfig, resolveAnyEnabledFeishuToolsConfig, resolveFeishuToolAccount, createFeishuToolClient, createFeishuClient, getFeishuRuntime, isRecord$1, readString, extractReplyText, encodeQuery } from '../shim.mjs'
//#region extensions/feishu/src/chat-schema.ts
const CHAT_ACTION_VALUES = [
	"members",
	"info",
	"member_info"
];
const MEMBER_ID_TYPE_VALUES = [
	"open_id",
	"user_id",
	"union_id"
];
const FeishuChatSchema = Type.Object({
	action: Type.Unsafe({
		type: "string",
		enum: [...CHAT_ACTION_VALUES],
		description: "Action to run: members | info | member_info"
	}),
	chat_id: Type.Optional(Type.String({ description: "Chat ID (from URL or event payload)" })),
	member_id: Type.Optional(Type.String({ description: "Member ID for member_info lookups" })),
	page_size: optionalPositiveIntegerSchema({
		maximum: 100,
		description: "Page size (1-100, default 50)"
	}),
	page_token: Type.Optional(Type.String({ description: "Pagination token" })),
	member_id_type: Type.Optional(Type.Unsafe({
		type: "string",
		enum: [...MEMBER_ID_TYPE_VALUES],
		description: "Member ID type (default: open_id)"
	}))
});
//#endregion
//#region extensions/feishu/src/chat.ts
function readChatPageSize(params) {
	return readPositiveIntegerParam(params, "page_size", {
		max: 100,
		message: "page_size must be a positive integer between 1 and 100"
	});
}
async function getChatInfo(client, chatId) {
	const res = await client.im.chat.get({ path: { chat_id: chatId } });
	if (res.code !== 0) throw new Error(res.msg);
	const chat = res.data;
	return {
		chat_id: chatId,
		name: chat?.name,
		description: chat?.description,
		owner_id: chat?.owner_id,
		tenant_key: chat?.tenant_key,
		user_count: chat?.user_count,
		chat_mode: chat?.chat_mode,
		chat_type: chat?.chat_type,
		join_message_visibility: chat?.join_message_visibility,
		leave_message_visibility: chat?.leave_message_visibility,
		membership_approval: chat?.membership_approval,
		moderation_permission: chat?.moderation_permission,
		avatar: chat?.avatar
	};
}
async function getChatMembers(client, chatId, pageSize, pageToken, memberIdType) {
	const page_size = pageSize ? Math.max(1, Math.min(100, pageSize)) : 50;
	const res = await client.im.chatMembers.get({
		path: { chat_id: chatId },
		params: {
			page_size,
			page_token: pageToken,
			member_id_type: memberIdType ?? "open_id"
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		chat_id: chatId,
		has_more: res.data?.has_more,
		page_token: res.data?.page_token,
		members: res.data?.items?.map((item) => ({
			member_id: item.member_id,
			name: item.name,
			tenant_key: item.tenant_key,
			member_id_type: item.member_id_type
		})) ?? []
	};
}
async function getFeishuMemberInfo(client, memberId, memberIdType = "open_id") {
	const res = await client.contact.user.get({
		path: { user_id: memberId },
		params: {
			user_id_type: memberIdType,
			department_id_type: "open_department_id"
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	const user = res.data?.user;
	return {
		member_id: memberId,
		member_id_type: memberIdType,
		open_id: user?.open_id,
		user_id: user?.user_id,
		union_id: user?.union_id,
		name: user?.name,
		en_name: user?.en_name,
		nickname: user?.nickname,
		email: user?.email,
		enterprise_email: user?.enterprise_email,
		mobile: user?.mobile,
		mobile_visible: user?.mobile_visible,
		status: user?.status,
		avatar: user?.avatar,
		department_ids: user?.department_ids,
		department_path: user?.department_path,
		leader_user_id: user?.leader_user_id,
		city: user?.city,
		country: user?.country,
		work_station: user?.work_station,
		join_time: user?.join_time,
		is_tenant_manager: user?.is_tenant_manager,
		employee_no: user?.employee_no,
		employee_type: user?.employee_type,
		description: user?.description,
		job_title: user?.job_title,
		geo: user?.geo
	};
}
function registerFeishuChatTools(api) {
	if (!api.config) return;
	const accounts = listEnabledFeishuAccounts(api.config);
	if (accounts.length === 0) return;
	const firstAccount = accounts[0];
	if (!resolveToolsConfig(firstAccount.config.tools).chat) return;
	const getClient = () => createFeishuClient(firstAccount);
	api.registerTool({
		name: "feishu_chat",
		label: "Feishu Chat",
		description: "Feishu chat operations. Actions: members, info, member_info",
		parameters: FeishuChatSchema,
		async execute(_toolCallId, params) {
			const rawParams = params;
			const p = params;
			try {
				const client = getClient();
				switch (p.action) {
					case "members":
						if (!p.chat_id) return jsonResult({ error: "chat_id is required for action members" });
						return jsonResult(await getChatMembers(client, p.chat_id, readChatPageSize(rawParams), p.page_token, p.member_id_type));
					case "info":
						if (!p.chat_id) return jsonResult({ error: "chat_id is required for action info" });
						return jsonResult(await getChatInfo(client, p.chat_id));
					case "member_info":
						if (!p.member_id) return jsonResult({ error: "member_id is required for action member_info" });
						return jsonResult(await getFeishuMemberInfo(client, p.member_id, p.member_id_type ?? "open_id"));
					default: return jsonResult({ error: `Unknown action: ${String(p.action)}` });
				}
			} catch (err) {
				return jsonResult({ error: formatFeishuApiError(err, { includeNestedErrorLogId: true }) });
			}
		}
	}, { name: "feishu_chat" });
}
//#endregion
//#region extensions/feishu/src/tool-result.ts
function unknownToolActionResult(action) {
	return jsonResult({ error: `Unknown action: ${String(action)}` });
}
function toolExecutionErrorResult(error) {
	return jsonResult({ error: formatErrorMessage(error) });
}
//#endregion
//#region extensions/feishu/src/drive-schema.ts
const FileType = Type.Union([
	Type.Literal("doc"),
	Type.Literal("docx"),
	Type.Literal("sheet"),
	Type.Literal("bitable"),
	Type.Literal("folder"),
	Type.Literal("file"),
	Type.Literal("mindnote"),
	Type.Literal("shortcut")
]);
const CommentFileType = Type.Union([
	Type.Literal("doc"),
	Type.Literal("docx"),
	Type.Literal("sheet"),
	Type.Literal("file"),
	Type.Literal("slides")
]);
const FeishuDriveSchema = Type.Union([
	Type.Object({
		action: Type.Literal("list"),
		folder_token: Type.Optional(Type.String({ description: "Folder token (optional, omit for root directory)" })),
		page_size: Type.Optional(Type.Integer({
			minimum: 1,
			maximum: 200,
			description: "Items per folder page (1-200; requires folder_token)"
		})),
		page_token: Type.Optional(Type.String({ description: "Continuation token from a prior list result (requires the same folder_token)" }))
	}),
	Type.Object({
		action: Type.Literal("info"),
		file_token: Type.String({ description: "File or folder token" }),
		type: FileType
	}),
	Type.Object({
		action: Type.Literal("create_folder"),
		name: Type.String({ description: "Folder name" }),
		folder_token: Type.Optional(Type.String({ description: "Parent folder token (optional, omit for root)" }))
	}),
	Type.Object({
		action: Type.Literal("move"),
		file_token: Type.String({ description: "File token to move" }),
		type: FileType,
		folder_token: Type.String({ description: "Target folder token" })
	}),
	Type.Object({
		action: Type.Literal("delete"),
		file_token: Type.String({ description: "File token to delete" }),
		type: FileType
	}),
	Type.Object({
		action: Type.Literal("list_comments"),
		file_token: Type.String({ description: "Document token" }),
		file_type: Type.Optional(CommentFileType),
		page_size: Type.Optional(Type.Integer({
			minimum: 1,
			maximum: 100,
			description: "Page size"
		})),
		page_token: Type.Optional(Type.String({ description: "Comment page token" }))
	}),
	Type.Object({
		action: Type.Literal("list_comment_replies"),
		file_token: Type.String({ description: "Document token" }),
		file_type: Type.Optional(CommentFileType),
		comment_id: Type.String({ description: "Comment id" }),
		page_size: Type.Optional(Type.Integer({
			minimum: 1,
			maximum: 100,
			description: "Page size"
		})),
		page_token: Type.Optional(Type.String({ description: "Reply page token" }))
	}),
	Type.Object({
		action: Type.Literal("add_comment"),
		file_token: Type.String({ description: "Document token" }),
		file_type: Type.Optional(Type.Union([Type.Literal("doc"), Type.Literal("docx")], { description: "Document type. Defaults to docx when omitted." })),
		content: Type.String({ description: "Comment text content" }),
		block_id: Type.Optional(Type.String({ description: "Optional docx block id for a local comment. Omit to create a full-document comment." }))
	}),
	Type.Object({
		action: Type.Literal("reply_comment"),
		file_token: Type.String({ description: "Document token" }),
		file_type: Type.Optional(CommentFileType),
		comment_id: Type.String({ description: "Comment id" }),
		content: Type.String({ description: "Reply text content" })
	})
]);
//#endregion
//#region extensions/feishu/src/drive.ts
var FeishuReplyCommentError = class extends Error {
	constructor(params) {
		super(params.message);
		this.name = "FeishuReplyCommentError";
		this.httpStatus = params.httpStatus;
		this.feishuCode = params.feishuCode;
		this.feishuMsg = params.feishuMsg;
		this.feishuLogId = params.feishuLogId;
	}
};
const FEISHU_DRIVE_REQUEST_TIMEOUT_MS = 3e4;
function getDriveInternalClient(client) {
	return client;
}
function buildReplyElements(content) {
	return [{
		type: "text",
		text: content
	}];
}
async function requestDriveApi(params) {
	return await getDriveInternalClient(params.client).request({
		method: params.method,
		url: params.url,
		params: params.query ?? {},
		data: params.data ?? {},
		timeout: FEISHU_DRIVE_REQUEST_TIMEOUT_MS
	});
}
function assertDriveApiSuccess(response) {
	if (response.code !== 0) throw new Error(response.msg ?? "Feishu Drive API request failed");
	return response;
}
function normalizeCommentReply(reply) {
	return {
		reply_id: reply.reply_id,
		user_id: reply.user_id,
		create_time: reply.create_time,
		update_time: reply.update_time,
		text: extractReplyText(reply)
	};
}
function normalizeCommentCard(comment) {
	const replies = comment.reply_list?.replies ?? [];
	const rootReply = replies[0];
	return {
		comment_id: comment.comment_id,
		user_id: comment.user_id,
		create_time: comment.create_time,
		update_time: comment.update_time,
		is_solved: comment.is_solved,
		is_whole: comment.is_whole,
		quote: comment.quote,
		text: extractReplyText(rootReply),
		has_more_replies: comment.has_more,
		replies_page_token: comment.page_token,
		replies: replies.slice(1).map(normalizeCommentReply)
	};
}
function normalizeCommentPageSize(pageSize) {
	if (typeof pageSize !== "number" || !Number.isFinite(pageSize)) return;
	return String(Math.min(Math.max(Math.floor(pageSize), 1), 100));
}
function resolveAmbientCommentTarget(context) {
	const deliveryContext = context?.deliveryContext;
	if (deliveryContext?.channel && deliveryContext.channel !== "feishu") return null;
	return parseFeishuCommentTarget(deliveryContext?.to);
}
function applyAmbientCommentDefaults(params, context) {
	const ambient = resolveAmbientCommentTarget(context);
	if (!ambient) return params;
	return {
		...params,
		file_token: params.file_token?.trim() || ambient.fileToken,
		file_type: params.file_type ?? ambient.fileType,
		comment_id: params.comment_id?.trim() || ambient.commentId
	};
}
function applyAddCommentAmbientDefaults(params, context) {
	const ambient = resolveAmbientCommentTarget(context);
	if (!ambient || ambient.fileType !== "doc" && ambient.fileType !== "docx") return params;
	return {
		...params,
		file_token: params.file_token?.trim() || ambient.fileToken,
		file_type: params.file_type ?? ambient.fileType
	};
}
function applyAddCommentDefaults(params) {
	const fileType = params.file_type ?? "docx";
	if (!params.file_type) console.info(`[feishu_drive] add_comment missing file_type; defaulting to docx file_token=${params.file_token ?? "unknown"}`);
	return {
		...params,
		file_type: fileType
	};
}
function applyCommentFileTypeDefault(params, action) {
	const fileType = params.file_type ?? "docx";
	if (!params.file_type) console.info(`[feishu_drive] ${action} missing file_type; defaulting to docx file_token=${params.file_token ?? "unknown"}`);
	return {
		...params,
		file_type: fileType
	};
}
function formatDriveApiError(error) {
	return formatFeishuApiError(error, { includeConfigParams: true });
}
function extractDriveApiErrorMeta(error) {
	if (!isRecord$1(error)) return { message: typeof error === "string" ? error : JSON.stringify(error) };
	const response = isRecord$1(error.response) ? error.response : void 0;
	const responseData = isRecord$1(response?.data) ? response?.data : void 0;
	return {
		message: typeof error.message === "string" ? error.message : typeof error === "string" ? error : JSON.stringify(error),
		httpStatus: typeof response?.status === "number" ? response.status : void 0,
		feishuCode: typeof responseData?.code === "number" ? responseData.code : readString(responseData?.code),
		feishuMsg: readString(responseData?.msg),
		feishuLogId: readString(responseData?.log_id)
	};
}
function isReplyNotAllowedError(error) {
	if (!(error instanceof FeishuReplyCommentError)) return false;
	return error.feishuCode === 1069302;
}
async function getRootFolderToken(client) {
	const internalClient = getDriveInternalClient(client);
	const domain = internalClient.domain ?? "https://open.feishu.cn";
	const res = await internalClient.httpInstance.get(`${domain}/open-apis/drive/explorer/v2/root_folder/meta`);
	if (res.code !== 0) throw new Error(res.msg ?? "Failed to get root folder");
	const token = res.data?.token;
	if (!token) throw new Error("Root folder token not found");
	return token;
}
async function listFolder(client, params = {}) {
	const folderToken = typeof params.folder_token === "string" ? params.folder_token.trim() : void 0;
	const validFolderToken = folderToken && folderToken !== "0" ? folderToken : void 0;
	const pageSize = readPositiveIntegerParam(params, "page_size", {
		max: 200,
		message: "page_size must be a positive integer between 1 and 200"
	});
	const pageToken = typeof params.page_token === "string" ? params.page_token.trim() : void 0;
	const listParams = validFolderToken ? {
		folder_token: validFolderToken,
		...pageSize ? { page_size: pageSize } : {},
		...pageToken ? { page_token: pageToken } : {}
	} : {};
	const res = await client.drive.file.list({ params: listParams });
	if (res.code !== 0) throw new Error(res.msg);
	return {
		files: res.data?.files?.map((f) => ({
			token: f.token,
			name: f.name,
			type: f.type,
			url: f.url,
			created_time: f.created_time,
			modified_time: f.modified_time,
			owner_id: f.owner_id
		})) ?? [],
		next_page_token: res.data?.next_page_token
	};
}
async function getFileInfo(client, fileToken, folderToken) {
	const res = await client.drive.file.list({ params: folderToken ? { folder_token: folderToken } : {} });
	if (res.code !== 0) throw new Error(res.msg);
	const file = res.data?.files?.find((f) => f.token === fileToken);
	if (!file) throw new Error(`File not found: ${fileToken}`);
	return {
		token: file.token,
		name: file.name,
		type: file.type,
		url: file.url,
		created_time: file.created_time,
		modified_time: file.modified_time,
		owner_id: file.owner_id
	};
}
async function createFolder(client, name, folderToken) {
	let effectiveToken = folderToken && folderToken !== "0" ? folderToken : "0";
	if (effectiveToken === "0") try {
		effectiveToken = await getRootFolderToken(client);
	} catch {}
	const res = await client.drive.file.createFolder({ data: {
		name,
		folder_token: effectiveToken
	} });
	if (res.code !== 0) throw new Error(res.msg);
	return {
		token: res.data?.token,
		url: res.data?.url
	};
}
async function moveFile(client, fileToken, type, folderToken) {
	const res = await client.drive.file.move({
		path: { file_token: fileToken },
		data: {
			type,
			folder_token: folderToken
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		task_id: res.data?.task_id
	};
}
async function deleteFile(client, fileToken, type) {
	const res = await client.drive.file.delete({
		path: { file_token: fileToken },
		params: { type }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		task_id: res.data?.task_id
	};
}
async function listComments(client, params) {
	const response = assertDriveApiSuccess(await requestDriveApi({
		client,
		method: "GET",
		url: `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments` + encodeQuery({
			file_type: params.file_type,
			page_size: normalizeCommentPageSize(params.page_size),
			page_token: params.page_token,
			user_id_type: "open_id"
		})
	}));
	return {
		has_more: response.data?.has_more ?? false,
		page_token: response.data?.page_token,
		comments: (response.data?.items ?? []).map(normalizeCommentCard)
	};
}
async function listCommentReplies(client, params) {
	const response = assertDriveApiSuccess(await requestDriveApi({
		client,
		method: "GET",
		url: `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments/${encodeURIComponent(params.comment_id)}/replies` + encodeQuery({
			file_type: params.file_type,
			page_size: normalizeCommentPageSize(params.page_size),
			page_token: params.page_token,
			user_id_type: "open_id"
		})
	}));
	return {
		has_more: response.data?.has_more ?? false,
		page_token: response.data?.page_token,
		replies: (response.data?.items ?? []).map(normalizeCommentReply)
	};
}
async function addComment(client, params) {
	if (params.block_id?.trim() && params.file_type !== "docx") throw new Error("block_id is only supported for docx comments");
	return {
		success: true,
		...assertDriveApiSuccess(await requestDriveApi({
			client,
			method: "POST",
			url: `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/new_comments`,
			data: {
				file_type: params.file_type,
				reply_elements: buildReplyElements(params.content),
				...params.block_id?.trim() ? { anchor: { block_id: params.block_id.trim() } } : {}
			}
		})).data
	};
}
async function queryCommentById(client, params) {
	return assertDriveApiSuccess(await requestDriveApi({
		client,
		method: "POST",
		url: `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments/batch_query` + encodeQuery({
			file_type: params.file_type,
			user_id_type: "open_id"
		}),
		data: { comment_ids: [params.comment_id] }
	})).data?.items?.find((comment) => comment.comment_id?.trim() === params.comment_id);
}
async function replyComment(client, params) {
	const url = `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments/${encodeURIComponent(params.comment_id)}/replies`;
	const query = { file_type: params.file_type };
	try {
		const response = await requestDriveApi({
			client,
			method: "POST",
			url,
			query,
			data: { content: { elements: [{
				type: "text_run",
				text_run: { text: params.content }
			}] } }
		});
		if (response.code === 0) return {
			success: true,
			...response.data
		};
		console.warn(`[feishu_drive] replyComment failed comment=${params.comment_id} file_type=${params.file_type} code=${response.code ?? "unknown"} msg=${response.msg ?? "unknown"} log_id=${response.log_id ?? "unknown"}`);
		throw new FeishuReplyCommentError({
			message: response.msg ?? "Feishu Drive reply comment failed",
			feishuCode: response.code,
			feishuMsg: response.msg,
			feishuLogId: response.log_id
		});
	} catch (error) {
		if (error instanceof FeishuReplyCommentError) throw error;
		const meta = extractDriveApiErrorMeta(error);
		console.warn(`[feishu_drive] replyComment threw comment=${params.comment_id} file_type=${params.file_type} error=${formatDriveApiError(error)}`);
		throw new FeishuReplyCommentError({
			message: meta.message,
			httpStatus: meta.httpStatus,
			feishuCode: meta.feishuCode,
			feishuMsg: meta.feishuMsg,
			feishuLogId: meta.feishuLogId
		});
	}
}
async function deliverCommentThreadText(client, params) {
	let isWholeComment = params.is_whole_comment;
	if (isWholeComment === void 0) try {
		isWholeComment = (await queryCommentById(client, params))?.is_whole === true;
	} catch (error) {
		console.warn(`[feishu_drive] comment metadata preflight failed comment=${params.comment_id} file_type=${params.file_type} error=${formatErrorMessage(error)}`);
		isWholeComment = false;
	}
	if (isWholeComment) {
		if (params.file_type !== "doc" && params.file_type !== "docx") throw new Error(`Whole-document comment follow-ups are only supported for doc/docx (got ${params.file_type})`);
		const wholeCommentFileType = params.file_type;
		console.info(`[feishu_drive] whole-comment compatibility path comment=${params.comment_id} file_type=${params.file_type} mode=add_comment`);
		return {
			delivery_mode: "add_comment",
			...await addComment(client, {
				file_token: params.file_token,
				file_type: wholeCommentFileType,
				content: params.content
			})
		};
	}
	try {
		return {
			delivery_mode: "reply_comment",
			...await replyComment(client, params)
		};
	} catch (error) {
		if (error instanceof FeishuReplyCommentError && isReplyNotAllowedError(error)) {
			if (params.file_type !== "doc" && params.file_type !== "docx") throw error;
			const fallbackFileType = params.file_type;
			console.info(`[feishu_drive] reply-not-allowed compatibility path comment=${params.comment_id} file_type=${params.file_type} mode=add_comment log_id=${error.feishuLogId ?? "unknown"}`);
			return {
				delivery_mode: "add_comment",
				...await addComment(client, {
					file_token: params.file_token,
					file_type: fallbackFileType,
					content: params.content
				})
			};
		}
		throw error;
	}
}
function registerFeishuDriveTools(api) {
	if (!api.config) return;
	const accounts = listEnabledFeishuAccounts(api.config);
	if (accounts.length === 0) return;
	if (!resolveAnyEnabledFeishuToolsConfig(accounts).drive) return;
	api.registerTool((ctx) => {
		const defaultAccountId = ctx.agentAccountId;
		return {
			name: "feishu_drive",
			label: "Feishu Drive",
			description: "Feishu cloud storage operations. Actions: list, info, create_folder, move, delete, list_comments, list_comment_replies, add_comment, reply_comment",
			parameters: FeishuDriveSchema,
			async execute(_toolCallId, params) {
				const p = params;
				try {
					const client = createFeishuToolClient({
						api,
						executeParams: p,
						defaultAccountId,
						requiredTool: {
							family: "drive",
							label: "Drive"
						}
					});
					switch (p.action) {
						case "list": return jsonResult(await listFolder(client, {
							folder_token: p.folder_token,
							page_size: p.page_size,
							page_token: p.page_token
						}));
						case "info": return jsonResult(await getFileInfo(client, p.file_token));
						case "create_folder": return jsonResult(await createFolder(client, p.name, p.folder_token));
						case "move": return jsonResult(await moveFile(client, p.file_token, p.type, p.folder_token));
						case "delete": return jsonResult(await deleteFile(client, p.file_token, p.type));
						case "list_comments": return jsonResult(await listComments(client, applyCommentFileTypeDefault(applyAmbientCommentDefaults(p, ctx), "list_comments")));
						case "list_comment_replies": return jsonResult(await listCommentReplies(client, applyCommentFileTypeDefault(applyAmbientCommentDefaults(p, ctx), "list_comment_replies")));
						case "add_comment": {
							const resolved = applyAddCommentDefaults(applyAddCommentAmbientDefaults(p, ctx));
							try {
								return jsonResult(await addComment(client, resolved));
							} finally {
								cleanupAmbientCommentTypingReaction({
									client: getDriveInternalClient(client),
									deliveryContext: ctx.deliveryContext
								});
							}
						}
						case "reply_comment": {
							const resolved = applyCommentFileTypeDefault(applyAmbientCommentDefaults(p, ctx), "reply_comment");
							try {
								return jsonResult(await deliverCommentThreadText(client, resolved));
							} finally {
								cleanupAmbientCommentTypingReaction({
									client: getDriveInternalClient(client),
									deliveryContext: ctx.deliveryContext
								});
							}
						}
						default: return unknownToolActionResult(p.action);
					}
				} catch (err) {
					return toolExecutionErrorResult(err);
				}
			}
		};
	}, { name: "feishu_drive" });
}
//#endregion

export { registerFeishuChatTools, registerFeishuDriveTools, toolExecutionErrorResult, unknownToolActionResult }
