// wrangler 默认把 *.html 作为 Text 模块打包 (import 得到字符串)
declare module '*.html' {
  const text: string
  export default text
}
