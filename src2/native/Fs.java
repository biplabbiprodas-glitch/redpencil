package com.redpencil.phone;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/** Small Firestore REST client used by the background service when the app screen is asleep. */
final class Fs {
    private static String idToken = null;
    private static long idTokenExp = 0;

    private Fs() {}

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(CallService.PREFS, Context.MODE_PRIVATE); }

    static String docsBase(Context c) {
        return "https://firestore.googleapis.com/v1/projects/" + prefs(c).getString("project", "") + "/databases/(default)/documents";
    }

    static String docName(Context c, String path) {
        return "projects/" + prefs(c).getString("project", "") + "/databases/(default)/documents/" + path;
    }

    static synchronized void forgetToken() { idToken = null; idTokenExp = 0; }

    private static synchronized String token(Context c) throws Exception {
        if (idToken != null && System.currentTimeMillis() < idTokenExp) return idToken;
        SharedPreferences p = prefs(c);
        String refresh = p.getString("refresh", "");
        if (refresh.isEmpty()) throw new IOException("not signed in");
        String body = "grant_type=refresh_token&refresh_token=" + URLEncoder.encode(refresh, "UTF-8");
        JSONObject j = new JSONObject(raw("POST", "https://securetoken.googleapis.com/v1/token?key=" + p.getString("apiKey", ""),
            body, "application/x-www-form-urlencoded", null));
        idToken = j.getString("id_token");
        long life = 3600;
        try { life = Long.parseLong(j.optString("expires_in", "3600")); } catch (Exception ignored) {}
        idTokenExp = System.currentTimeMillis() + Math.max(60, life - 300) * 1000L;
        if (j.has("refresh_token")) p.edit().putString("refresh", j.getString("refresh_token")).apply();
        return idToken;
    }

    static String http(Context c, String method, String url, String json) throws Exception {
        try {
            return raw(method, url, json, "application/json", token(c));
        } catch (IOException e) {
            if (String.valueOf(e.getMessage()).startsWith("HTTP 401")) { forgetToken(); return raw(method, url, json, "application/json", token(c)); }
            throw e;
        }
    }

    private static String raw(String method, String url, String body, String type, String bearer) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestMethod(method);
        if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", type);
            try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes("UTF-8")); }
        }
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        if (in != null) {
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            in.close();
        }
        c.disconnect();
        String s = bo.toString("UTF-8");
        if (code >= 400) throw new IOException("HTTP " + code + " " + s);
        return s;
    }
}
