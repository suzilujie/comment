package com.xfish.comment.agent

import android.app.Application
import android.os.Process
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.SingleInstance
import com.xfish.comment.agent.data.Prefs
import com.xfish.comment.agent.exec.AppContextHolder
import com.xfish.comment.agent.netlink.ClashClient
import com.xfish.comment.agent.runtime.AgentService
import com.xfish.comment.agent.runtime.Notify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Application：初始化日志、上下文与常驻服务。
 *
 * 注意：**不在 Application 里做任何网络请求与重活**，
 * 否则会拖慢冷启动并可能触发系统 ANR 判定。初始化只保留最必要的几步。
 */
class App : Application() {

    override fun onCreate() {
        super.onCreate()

        Log.init(this)

        // 单实例保护：抢不到本机端口锁 → 已有实例（含分身/双开）在运行，本进程立即退出
        if (!SingleInstance.acquire()) {
            Log.w("app", "检测到已有实例运行（或互斥端口被占用），本进程退出")
            Process.killProcess(Process.myPid())
            return
        }

        AppContextHolder.context = applicationContext
        Notify.ensureChannel(this)

        Log.i("app", "启动（版本 ${BuildConfig.VERSION_NAME}）")

        // 启动常驻服务（无注册环节：设备首启心跳即自动登记）
        CoroutineScope(SupervisorJob() + Dispatchers.Default).launch {
            // 注入 Clash 控制器配置（面板可覆盖默认值）；若配置连不上则自动探测一次
            runCatching {
                val saved = Prefs.clashController(applicationContext)
                val secret = Prefs.clashSecret(applicationContext)
                ClashClient.configure(saved, secret)
                if (!ClashClient.ping()) {
                    ClashClient.autoDetect()?.let { found ->
                        ClashClient.configure(found, secret)
                        Prefs.setClashController(applicationContext, found)
                        Log.i("app", "自动探测到 Clash 控制器：$found")
                    }
                }
            }.onFailure { Log.w("app", "加载 Clash 配置失败：${it.message}") }

            Log.i("app", "拉起常驻服务")
            runCatching { AgentService.start(applicationContext) }
                .onFailure { Log.w("app", "启动服务失败：${it.message}") }
        }
    }
}
