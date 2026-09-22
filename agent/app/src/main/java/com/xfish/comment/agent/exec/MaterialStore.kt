package com.xfish.comment.agent.exec

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.net.Api
import com.xfish.comment.agent.net.TaskImageDto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 素材本地化（设计文档 §3.6 素材本地化 + §6.4 素材通道）。
 *
 * 关键点（**必须写相册，否则抖音选不到图**）：
 *  1. 素材随任务携带 → 内网通道下载（不走代理）；
 *  2. 按 hash 去重缓存到私有目录；
 *  3. 图文评论前写入系统相册（MediaStore，Android 10+ 用 IS_PENDING 两阶段写入）；
 *  4. **执行后延时清理**（立即删除会让抖音的引用失效）。
 */
object MaterialStore {

    private const val TAG = "material"
    private const val CACHE_DIR = "materials"
    private const val ALBUM_DIR = "CommentAgent"

    /** 确保素材已下载到私有缓存，返回本地文件路径 */
    suspend fun ensureCached(context: Context, image: TaskImageDto): String? = withContext(Dispatchers.IO) {
        val dir = File(context.filesDir, CACHE_DIR).apply { if (!exists()) mkdirs() }
        val dest = File(dir, image.hash)
        if (dest.exists() && dest.length() > 0) {
            Log.d(TAG, "素材命中缓存 ${image.hash} (${dest.length()} bytes)")
            return@withContext dest.absolutePath
        }
        return@withContext try {
            val size = Api.download(image.url, dest)
            Log.i(TAG, "素材下载完成 ${image.hash} ($size bytes)")
            dest.absolutePath
        } catch (e: Exception) {
            Log.e(TAG, "素材下载失败 ${image.hash}", e)
            null
        }
    }

    /**
     * 写入系统相册（MediaStore）。Android 10+ 必须用 IS_PENDING 两阶段提交，
     * 否则相册可能读到半截文件。
     * @return MediaStore uri（失败返回 null）
     */
    suspend fun publishToAlbum(context: Context, localPath: String, displayName: String): Uri? =
        withContext(Dispatchers.IO) {
            val file = File(localPath)
            if (!file.exists()) {
                Log.w(TAG, "publishToAlbum: 本地文件不存在 $localPath")
                return@withContext null
            }

            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
                put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$ALBUM_DIR")
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
            }

            try {
                val resolver = context.contentResolver
                val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                if (uri == null) {
                    Log.w(TAG, "MediaStore.insert 返回 null")
                    return@withContext null
                }
                resolver.openOutputStream(uri)?.use { out ->
                    file.inputStream().use { it.copyTo(out) }
                } ?: run {
                    resolver.delete(uri, null, null)
                    return@withContext null
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    resolver.update(uri, ContentValues().apply {
                        put(MediaStore.Images.Media.IS_PENDING, 0)
                    }, null, null)
                }
                Log.i(TAG, "素材已写入相册：$displayName → $uri")
                uri
            } catch (e: Exception) {
                Log.e(TAG, "写入相册失败", e)
                null
            }
        }

    /**
     * 延时清理相册条目（设计文档要求：**不能立即删**，否则抖音引用失效）。
     * 默认 10 分钟后清理；页面关闭或进程被杀时由下次启动的补偿逻辑处理。
     */
    suspend fun cleanupAlbumLater(context: Context, uris: List<Uri>, delayMs: Long = 10 * 60_000L) {
        if (uris.isEmpty()) return
        delay(delayMs)
        cleanupAlbum(context, uris)
    }

    /** 立即清理相册条目 */
    suspend fun cleanupAlbum(context: Context, uris: List<Uri>) = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        uris.forEach { uri ->
            runCatching { resolver.delete(uri, null, null) }
                .onSuccess { Log.i(TAG, "已清理相册条目 $uri") }
                .onFailure { Log.w(TAG, "清理相册条目失败 $uri: ${it.message}") }
        }
    }

    /**
     * 清理历史遗留的相册条目（进程被杀导致上一轮没清理干净）。
     * 启动时调用一次即可。
     */
    suspend fun sweepLegacyAlbum(context: Context) = withContext(Dispatchers.IO) {
        runCatching {
            val resolver = context.contentResolver
            val selection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                "${MediaStore.Images.Media.RELATIVE_PATH} LIKE ?"
            } else {
                "${MediaStore.Images.Media.DATA} LIKE ?"
            }
            val args = arrayOf("%$ALBUM_DIR%")
            val cursor = resolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.Images.Media._ID),
                selection,
                args,
                null,
            )
            var removed = 0
            cursor?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    val uri = Uri.withAppendedPath(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id.toString())
                    if (resolver.delete(uri, null, null) > 0) removed++
                }
            }
            if (removed > 0) Log.i(TAG, "启动清理遗留相册条目 $removed 张")
        }.onFailure { Log.w(TAG, "sweepLegacyAlbum 失败: ${it.message}") }
    }

    /** 清理过期缓存（保留最近 N 天的素材文件） */
    suspend fun pruneCache(context: Context, keepDays: Int = 7) = withContext(Dispatchers.IO) {
        val dir = File(context.filesDir, CACHE_DIR)
        val cutoff = System.currentTimeMillis() - keepDays * 24L * 3600_000L
        dir.listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
    }
}
