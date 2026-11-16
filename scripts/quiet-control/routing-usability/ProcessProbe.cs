// Isolated QA executable. Compile with different output names so Windows owns
// real process images; no UI, registry, proxy settings or DNS manipulation.
using System;using System.IO;using System.Net.Sockets;using System.Diagnostics;
using System.Text;using System.Threading;using System.Web.Script.Serialization;
class ProcessProbe {
 static int sourcePort;static readonly Stopwatch elapsed=Stopwatch.StartNew();
 static void Main(string[] args) {
  string output=args[0],response="",error="";bool received=false;
  int pid=Process.GetCurrentProcess().Id;
  try {
   using(var tcp=new TcpClient()) {
    tcp.ReceiveTimeout=15000;tcp.SendTimeout=5000;tcp.Connect(args[1],int.Parse(args[2]));sourcePort=((System.Net.IPEndPoint)tcp.Client.LocalEndPoint).Port;
    Thread.Sleep(int.Parse(args[4]));var stream=tcp.GetStream();
    if(args.Length>6&&args[6]=="mixed") {
     stream.Write(new byte[]{5,1,0},0,3);var greeting=Read(stream,2);if(greeting[1]!=0)throw new Exception("SOCKS authentication rejected");
     var host=Encoding.ASCII.GetBytes(args[3]);using(var packet=new MemoryStream()){packet.Write(new byte[]{5,1,0,3,(byte)host.Length},0,5);packet.Write(host,0,host.Length);packet.WriteByte(130);packet.WriteByte(20);var bytes=packet.ToArray();stream.Write(bytes,0,bytes.Length);}
     var reply=Read(stream,4);if(reply[1]!=0)throw new Exception("SOCKS connect rejected: "+reply[1]);if(reply[3]==1)Read(stream,6);else if(reply[3]==4)Read(stream,18);else if(reply[3]==3)Read(stream,Read(stream,1)[0]+2);else throw new Exception("Invalid SOCKS reply");
    }
    var request=Encoding.ASCII.GetBytes("GET /probe?pid="+pid+" HTTP/1.1\r\nHost: "+args[3]+"\r\nConnection: keep-alive\r\n\r\n");stream.Write(request,0,request.Length);
    var buffer=new byte[4096];int total=0;
    while(total<buffer.Length) {int count=stream.Read(buffer,total,buffer.Length-total);if(count==0)break;total+=count;response=Encoding.ASCII.GetString(buffer,0,total);int end=response.IndexOf("\r\n\r\n");if(end>=0&&(response.Length>=end+10||response.IndexOf("Content-Length: 0",StringComparison.OrdinalIgnoreCase)>=0))break;}
    received=response.StartsWith("HTTP/1.");Write(output,pid,response,error,received);
    Thread.Sleep(int.Parse(args[5]));
   }
  } catch(Exception e) {error=e.Message;Write(output,pid,response,error,received);}
 }
 static byte[] Read(Stream stream,int count){var data=new byte[count];int offset=0;while(offset<count){int n=stream.Read(data,offset,count-offset);if(n==0)throw new Exception("SOCKS closed");offset+=n;}return data;}
 static void Write(string path,int pid,string response,string error,bool received) {
  int end=response.IndexOf("\r\n\r\n");string body=end>=0?response.Substring(end+4):"";
  string marker=body.StartsWith("VPN")?"VPN":body.StartsWith("DIRECT")?"DIRECT":"";
  var data=new {elapsed_ms=elapsed.ElapsedMilliseconds,at=DateTime.UtcNow.ToString("o"),pid=pid,source_port=sourcePort,process=Process.GetCurrentProcess().ProcessName+".exe",image=Process.GetCurrentProcess().MainModule.FileName,received=received,marker=marker,error=error,preview=response.Substring(0,Math.Min(response.Length,256))};
  File.WriteAllText(path,new JavaScriptSerializer().Serialize(data),new UTF8Encoding(false));
 }
}
